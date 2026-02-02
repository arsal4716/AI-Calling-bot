export const API_CONFIG = {
  BASE_URL: 'https://voiceagentbot.com/api',
  SOCKET_URL: 'wss://voiceagentbot.com/media-stream',
};

export const ROUTES = {
  LOGIN: '/login',
  REGISTER: '/register',
  DASHBOARD: '/dashboard',
  CAMPAIGNS: '/campaigns',
  VOICES: '/voices',
  USERS: '/users',
  GUIDE: '/guide',
};

export const TWILIO_CONFIG = {
  SUPPORTED_DIALERS: ['Vapi', 'Vicidial', 'Asterisk', 'FreeSWITCH', 'Custom'],
  SIP_PROTOCOLS: ['TCP', 'UDP', 'TLS'],
  CODECS: ['PCMU', 'PCMA', 'G722', 'OPUS'],
};

export const AI_SERVICES = {
  OPENAI_MODELS: ['gpt-4', 'gpt-3.5-turbo'],
  DEEPGRAM_MODELS: ['nova', 'enhanced', 'base'],
  ELEVENLABS_MODELS: ['eleven_monolingual_v1', 'eleven_multilingual_v1'],
};

export const VOICE_SETTINGS_DEFAULTS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
};

export const CAMPAIGN_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  DRAFT: 'draft',
  ARCHIVED: 'archived',
};

export const CALL_STATUS = {
  INITIATED: 'initiated',
  RINGING: 'ringing',
  QUEUED: 'queued',
  CONNECTING: 'connecting',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BUSY: 'busy',
  NO_ANSWER: 'no_answer',
  CANCELED: 'canceled',
  QUEUE_FAILED: 'queue_failed',
};
