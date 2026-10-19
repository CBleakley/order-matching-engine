import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';

function capture(): { lines: string[]; stream: { write(line: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (line: string) => lines.push(line) } };
}

describe('createLogger', () => {
  it('writes JSON lines at the configured level', () => {
    const { lines, stream } = capture();
    const logger = createLogger('info', stream);
    logger.debug('hidden');
    logger.info({ answer: 42 }, 'hello');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 30,
      service: 'gateway',
      answer: 42,
      msg: 'hello',
    });
  });

  it('redacts secrets', () => {
    const { lines, stream } = capture();
    const logger = createLogger('info', stream);
    logger.info(
      {
        sessionSecret: 's3cret-a',
        config: { sessionSecret: 's3cret-b' },
        token: 's3cret-c',
        session: { token: 's3cret-d' },
        req: { headers: { authorization: 's3cret-e', cookie: 's3cret-f', host: 'example' } },
      },
      'secrets',
    );
    const line = lines.join('');
    expect(line).not.toMatch(/s3cret/);
    expect(JSON.parse(line)).toMatchObject({
      sessionSecret: '[redacted]',
      config: { sessionSecret: '[redacted]' },
      req: { headers: { authorization: '[redacted]', host: 'example' } },
    });
  });
});
