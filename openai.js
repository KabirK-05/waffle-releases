// OpenAI API provider: answers through the Responses API with the user's own OpenAI key.
// Plain fetch with server-sent events, so no extra dependency. The key is the same one the
// speech fallback uses (secrets.json `speechKeyEnc`), and requests only ever go to api.openai.com.

const API = 'https://api.openai.com/v1';
const FALLBACK_MODEL = 'gpt-5';

class OpenAIError extends Error {
  constructor(message, { status, needsKey = false, aborted = false } = {}) {
    super(message);
    this.status = status;
    this.needsKey = needsKey;
    this.aborted = aborted;
  }
}

/** Turn an HTTP failure into a message a person can act on. */
async function httpError(res) {
  let detail = '';
  try {
    detail = (await res.json())?.error?.message || '';
  } catch {
    /* no JSON body */
  }
  if (res.status === 401) return new OpenAIError('The OpenAI API key was rejected. Enter a valid key in Settings.', { status: 401, needsKey: true });
  if (res.status === 403) return new OpenAIError(detail || 'This OpenAI key cannot use the selected model.', { status: 403 });
  if (res.status === 404) return new OpenAIError('The selected OpenAI model was not found. Check it in Settings.', { status: 404 });
  if (res.status === 429) return new OpenAIError(detail || 'Rate limited by OpenAI. Wait a moment and try again.', { status: 429 });
  return new OpenAIError(`OpenAI error (${res.status}): ${detail || res.statusText}`, { status: res.status });
}

const headers = (apiKey) => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

// Reasoning models take `reasoning.effort`; older chat models reject the parameter.
const isReasoningModel = (model) => /^(gpt-5|o\d)/.test(model);

/** Waffle's history is in Anthropic message format; convert it to Responses API input items. */
function toInput(messages) {
  const input = [];
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content) }];
    if (message.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      continue;
    }
    const content = [];
    for (const b of blocks) {
      if (b.type === 'text') content.push({ type: 'input_text', text: b.text });
      else if (b.type === 'image' && b.source?.type === 'base64') {
        content.push({ type: 'input_image', image_url: `data:${b.source.media_type};base64,${b.source.data}` });
      }
    }
    if (content.length) input.push({ role: 'user', content });
  }
  return input;
}

/** The mode's PDFs as an opening user message, mirroring referenceMessages() for Anthropic. */
function documentInput(documents) {
  if (!documents?.length) return [];
  return [
    {
      role: 'user',
      content: [
        ...documents.map((doc) => ({ type: 'input_file', filename: doc.name, file_data: `data:application/pdf;base64,${doc.base64}` })),
        { type: 'input_text', text: 'These are the reference files for the current mode.' },
      ],
    },
    { role: 'assistant', content: [{ type: 'output_text', text: 'Understood. I will use them when they are relevant.' }] },
  ];
}

function requestBody({ model, system, input, effort, maxTokens, stream }) {
  const body = { model, instructions: system, input, max_output_tokens: maxTokens, store: false, stream };
  if (effort && isReasoningModel(model)) body.reasoning = { effort };
  return body;
}

/**
 * Stream one answer. Returns { abort(), done } like providers.startStream, where `done`
 * resolves to { text, refused, truncated }.
 */
function startStream({ apiKey, model, system, documents, history, userMessage, effort, onDelta }) {
  const controller = new AbortController();
  const done = (async () => {
    let res;
    try {
      res = await fetch(`${API}/responses`, {
        method: 'POST',
        headers: headers(apiKey),
        signal: controller.signal,
        body: JSON.stringify(
          requestBody({
            model: model || FALLBACK_MODEL,
            system,
            input: [...documentInput(documents), ...toInput([...history, userMessage])],
            effort,
            maxTokens: 16000,
            stream: true,
          }),
        ),
      });
    } catch (err) {
      if (controller.signal.aborted) throw new OpenAIError('Aborted.', { aborted: true });
      throw new OpenAIError('Could not reach OpenAI. Check your connection.');
    }
    if (!res.ok) throw await httpError(res);

    let text = '';
    let refused = false;
    let truncated = false;
    const handle = (event) => {
      switch (event.type) {
        case 'response.output_text.delta':
          text += event.delta;
          onDelta?.(event.delta);
          break;
        case 'response.refusal.delta':
          refused = true;
          break;
        case 'response.incomplete':
          truncated = event.response?.incomplete_details?.reason === 'max_output_tokens';
          break;
        case 'response.failed':
          throw new OpenAIError(event.response?.error?.message || 'OpenAI could not finish the answer.');
        case 'error':
          throw new OpenAIError(event.message || 'OpenAI returned an error.');
        default:
          break;
      }
    };

    try {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data || data === '[DONE]') continue;
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }
          handle(event);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) throw new OpenAIError('Aborted.', { aborted: true });
      throw err;
    }
    return { text, refused: refused && !text, truncated };
  })();
  return { abort: () => controller.abort(), done };
}

/** A one-off, non-streamed answer (session summaries). */
async function complete({ apiKey, model, system, prompt }) {
  let res;
  try {
    res = await fetch(`${API}/responses`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify(
        requestBody({
          model: model || FALLBACK_MODEL,
          system,
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
          effort: 'low',
          maxTokens: 4000,
          stream: false,
        }),
      ),
    });
  } catch {
    throw new OpenAIError('Could not reach OpenAI. Check your connection.');
  }
  if (!res.ok) throw await httpError(res);
  const reply = await res.json();
  return (reply.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');
}

// Families that answer text-and-image chat; everything else in /v1/models (audio, realtime,
// embeddings, image generation, moderation…) is left out of the picker.
const CHAT_MODEL = /^(gpt-[45]|o\d|chatgpt-)/;
const NOT_CHAT = /(audio|realtime|transcribe|tts|search|image|embedding|moderation|instruct|codex|-\d{4}-\d{2}-\d{2}$)/;

let modelCache = null; // { key, result }

/** Models this key can use for answers, newest first, plus the one used when none is chosen. */
async function listModels(apiKey) {
  if (!apiKey) return { models: [], defaultModel: FALLBACK_MODEL };
  if (modelCache?.key === apiKey) return modelCache.result;
  let ids = [];
  try {
    const res = await fetch(`${API}/models`, { headers: headers(apiKey) });
    if (res.ok) {
      ids = ((await res.json()).data || [])
        .filter((m) => CHAT_MODEL.test(m.id) && !NOT_CHAT.test(m.id))
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map((m) => m.id);
    }
  } catch {
    /* offline: fall through with no list */
  }
  const defaultModel = ids.find((id) => /^gpt-5/.test(id) && !/(mini|nano|chat)/.test(id)) || ids[0] || FALLBACK_MODEL;
  const result = { models: ids.map((id) => ({ id, label: id, description: '' })), defaultModel };
  if (ids.length) modelCache = { key: apiKey, result };
  return result;
}

module.exports = { startStream, complete, listModels, OpenAIError, FALLBACK_MODEL };
