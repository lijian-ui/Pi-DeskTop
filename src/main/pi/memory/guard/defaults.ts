/**
 * Built-in floor rules for the memory content guard.
 *
 * These are conservative, high-precision patterns: they catch obvious secrets
 * and injection shapes without false-positiveing on ordinary technical prose.
 * Users can disable any of them or add stricter ones via guard-rules.json.
 */

import type { GuardRule } from './types';

export const DEFAULT_GUARD_RULES: readonly GuardRule[] = [
  // ── Credentials ──
  {
    id: 'cred-api-key-assignment',
    name: 'API key / secret assignment',
    category: 'credential',
    pattern: '(?:api[_-]?key|secret|token|access[_-]?token|auth[_-]?token|password|passwd|pwd|client[_-]?secret)\\s*[:=]\\s*["\']?[A-Za-z0-9_\\-./+]{8,}',
    description: 'Looks like a credential assigned inline (key="..." / password: ...).',
  },
  {
    id: 'cred-aws-key',
    name: 'AWS access key',
    category: 'credential',
    pattern: 'AKIA[0-9A-Z]{16}',
    description: 'AWS access key id (AKIA...).',
  },
  {
    id: 'cred-private-key',
    name: 'Private key block',
    category: 'credential',
    pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    description: 'PEM private key block.',
  },
  {
    id: 'cred-jwt',
    name: 'JWT token',
    category: 'credential',
    pattern: 'eyJ[A-Za-z0-9_\\-]+\\.eyJ[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+',
    description: 'JSON Web Token (header.payload.signature).',
  },
  {
    id: 'cred-ghp',
    name: 'GitHub token',
    category: 'credential',
    pattern: 'gh[po]_[A-Za-z0-9]{36,}',
    description: 'GitHub personal/office token (ghp_/gho_).',
  },
  {
    id: 'cred-openai',
    name: 'OpenAI / sk- style key',
    category: 'credential',
    pattern: 'sk-[A-Za-z0-9]{20,}',
    description: 'OpenAI-style secret key (sk-...).',
  },
  // ── Prompt injection ──
  {
    id: 'inj-ignore-instructions',
    name: 'Ignore-instructions injection',
    category: 'prompt-injection',
    pattern: 'ignore (?:all |the |any |previous |above )?(?:prior |previous |above )?instructions',
    description: 'Attempt to override the system prompt.',
  },
  {
    id: 'inj-reveal-prompt',
    name: 'Reveal-system-prompt injection',
    category: 'prompt-injection',
    pattern: '(?:(?:reveal|print|show|dump|output)(?: me)? (?:the|your) (?:system )?(?:prompt|instructions))|(?:(?:disregard|forget|override) (?:the|your|all) (?:previous|system|prior))',
    description: 'Attempt to extract or discard system instructions.',
  },
  {
    id: 'inj-system-tags',
    name: 'System-tag injection',
    category: 'prompt-injection',
    pattern: '<\\s*system\\s*>|<\\s*\\/\\s*system\\s*>|<<\\s*SYS',
    description: 'Raw <system> tags or SYS delimiters that could smuggle instructions.',
  },
  {
    id: 'inj-template-injection',
    name: 'Template / control injection',
    category: 'prompt-injection',
    pattern: '\\{\\{.*\\}\\}|<%[^>]+%>',
    description: 'Template/control-flow syntax that could be interpreted as instructions.',
  },
  // ── Encoded payloads ──
  {
    id: 'enc-base64-blob',
    name: 'Long base64 blob',
    category: 'encoded-payload',
    pattern: '(?:[A-Za-z0-9+/]{60,}={0,2})',
    description: 'Suspiciously long base64 run (likely an embedded/encoded payload).',
  },
  {
    id: 'enc-hex-dump',
    name: 'Long hex dump',
    category: 'encoded-payload',
    pattern: '(?:[0-9a-fA-F]{64,})',
    description: 'Suspiciously long hex run (likely an embedded/encoded payload).',
  },
];
