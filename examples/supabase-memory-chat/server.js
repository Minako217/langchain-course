import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const {
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4.1-mini',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PORT = 8787,
} = process.env;

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing required environment variables. Check .env.example');
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const SYSTEM_PROMPT = [
  '你是赴日留学生助手，服务中国赴日大学院及以上留学生。',
  '先判断用户阶段（落地前/机场/一周内/长期），信息不足时最多追问3个关键问题。',
  '回答必须提供可执行步骤，并优先给官方渠道建议。',
  '不要编造法规；不确定时明确说明并建议用户联系官方窗口确认。',
].join('\n');

const RECENT_MESSAGES_LIMIT = 12;
const SUMMARY_REFRESH_EVERY = 10;

function asInputMessages(messages) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

async function getOrCreateUserProfile(externalUserId) {
  let { data: existing, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('external_user_id', externalUserId)
    .maybeSingle();

  if (error) throw error;
  if (existing) return existing;

  const { data: created, error: insertError } = await supabase
    .from('user_profiles')
    .insert({ external_user_id: externalUserId })
    .select('*')
    .single();

  if (insertError) throw insertError;
  return created;
}

async function getOrCreateConversation(userProfileId, conversationId) {
  if (conversationId) {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', conversationId)
      .eq('user_profile_id', userProfileId)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;
  }

  const { data: created, error: createError } = await supabase
    .from('conversations')
    .insert({ user_profile_id: userProfileId, title: 'New conversation' })
    .select('*')
    .single();

  if (createError) throw createError;
  return created;
}

async function getRecentMessages(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(RECENT_MESSAGES_LIMIT);

  if (error) throw error;
  return (data ?? []).reverse();
}

async function saveMessage(conversationId, role, content) {
  const { error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, role, content });

  if (error) throw error;
}

async function countMessages(conversationId) {
  const { count, error } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conversationId);

  if (error) throw error;
  return count ?? 0;
}

async function refreshConversationSummary(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(80);

  if (error) throw error;

  const input = [
    { role: 'system', content: '请将以下对话压缩成100~180字中文摘要，包含用户阶段、已完成事项、未完成事项、当前紧急问题。' },
    ...asInputMessages(data ?? []),
  ];

  const resp = await openai.responses.create({
    model: OPENAI_MODEL,
    input,
  });

  const summary = resp.output_text?.trim() || '';

  const { error: updateError } = await supabase
    .from('conversations')
    .update({ memory_summary: summary })
    .eq('id', conversationId);

  if (updateError) throw updateError;
  return summary;
}

async function extractProfilePatch(userText, assistantText) {
  const schemaHint = `\n只返回JSON对象，字段仅允许：school_name, city, ward, stage, urgent_issue, japanese_level, profile_summary。\n若未知则省略字段。stage 只能是 pre_arrival|airport|week1|long_term。`;

  const resp = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      { role: 'system', content: '你是信息抽取器。' + schemaHint },
      { role: 'user', content: `用户消息：${userText}\n助手回复：${assistantText}` },
    ],
    text: { format: { type: 'json_object' } },
  });

  try {
    return JSON.parse(resp.output_text || '{}');
  } catch {
    return {};
  }
}

app.post('/api/chat', async (req, res) => {
  try {
    const { external_user_id, conversation_id, message } = req.body ?? {};

    if (!external_user_id || !message) {
      return res.status(400).json({ error: 'external_user_id and message are required' });
    }

    const profile = await getOrCreateUserProfile(external_user_id);
    const conversation = await getOrCreateConversation(profile.id, conversation_id);
    const recentMessages = await getRecentMessages(conversation.id);

    const contextMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'system',
        content: `用户画像(JSON): ${JSON.stringify({
          school_name: profile.school_name,
          city: profile.city,
          ward: profile.ward,
          arrival_date: profile.arrival_date,
          stage: profile.stage,
          urgent_issue: profile.urgent_issue,
          japanese_level: profile.japanese_level,
          profile_summary: profile.profile_summary,
        })}`,
      },
      {
        role: 'system',
        content: `会话摘要: ${conversation.memory_summary || '暂无摘要'}`,
      },
      ...asInputMessages(recentMessages),
      { role: 'user', content: message },
    ];

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: contextMessages,
    });

    const reply = response.output_text?.trim() || '我暂时无法回答这个问题，请稍后再试。';

    await saveMessage(conversation.id, 'user', message);
    await saveMessage(conversation.id, 'assistant', reply);

    const patch = await extractProfilePatch(message, reply);
    if (Object.keys(patch).length > 0) {
      const { error: patchError } = await supabase
        .from('user_profiles')
        .update(patch)
        .eq('id', profile.id);
      if (patchError) throw patchError;
    }

    const msgCount = await countMessages(conversation.id);
    let refreshedSummary = conversation.memory_summary;
    if (msgCount % SUMMARY_REFRESH_EVERY === 0) {
      refreshedSummary = await refreshConversationSummary(conversation.id);
    }

    return res.json({
      conversation_id: conversation.id,
      reply,
      memory_summary: refreshedSummary,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/healthz', (_, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
