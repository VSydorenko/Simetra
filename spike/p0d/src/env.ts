// Ключі й адреси власного стеку спайку читаються з CLI під час прогону:
// у репо їх немає.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workdir = fileURLToPath(new URL('..', import.meta.url));
const status = JSON.parse(
  execFileSync(fileURLToPath(new URL('../../../node_modules/.bin/supabase', import.meta.url)), ['status', '-o', 'json', '--workdir', workdir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
) as Record<string, string>;

export const env = {
  apiUrl: status.API_URL!,
  dbUrl: status.DB_URL!,
  anonKey: status.ANON_KEY!,
  serviceKey: status.SERVICE_ROLE_KEY!,
};
