// Node 22, erasable TypeScript, standard library only. The model and page share one dataset.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repository = fileURLToPath(new URL('.', import.meta.url));

function localPath(value: string, flag: string): string {
  if (!value.trim() || /^https?:/i.test(value)) throw new Error(`${flag} requires a local filesystem path`);
  return resolve(value);
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** Recursively copy regular files. Refuse links and special files instead of following them. */
function copyTree(source: string, destination: string): number {
  if (!existsSync(source)) return 0;
  if (!lstatSync(source).isDirectory()) throw new Error(`${source} must be a directory`);
  mkdirSync(destination, { recursive: true });
  let count = 0;
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.name.startsWith('.')) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) count += copyTree(from, to);
    else if (entry.isFile()) { copyFileSync(from, to); count++; }
    else throw new Error(`${from} must be a regular file or directory`);
  }
  return count;
}

function run(): void {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } }, strict: true, allowPositionals: false });
  const input = localPath(values.input ?? '/input', '--input');
  const inputFile = statSync(input).isDirectory() ? join(input, 'snapshot.json') : input;
  const out = localPath(values.output ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output', '--output');
  // A destination must never replace its own source trees or an ancestor of this repository.
  if (isWithin(out, repository) || ['dashboard', 'screenshots', 'lib', 'vendor', '.git'].some((dir) => isWithin(join(repository, dir), out))) {
    throw new Error('--output overlaps repository source; choose a separate output directory');
  }
  const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) throw new Error(`board refused: ${issue}`);

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  writeFileSync(join(out, 'data.js'), dataScript(radar));
  // Remove only generated artifacts so a rerun cannot retain old screenshots or a stale dossier.
  rmSync(join(out, 'dossier.json'), { force: true });
  for (const dir of ['dashboard', 'screenshots']) rmSync(join(out, dir), { recursive: true, force: true });
  const dashboardFiles = copyTree(join(repository, 'dashboard'), join(out, 'dashboard'));
  copyTree(join(repository, 'screenshots'), join(out, 'screenshots'));
  const shotsDir = join(out, 'screenshots');
  const shots = existsSync(shotsDir) ? readdirSync(shotsDir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.')) : [];
  if (shots.length < 3 || shots.length > 4 || shots.some((entry) => !entry.isFile() || !/\.(png|jpe?g)$/i.test(entry.name))) {
    throw new Error(`screenshots/ requires 3..4 PNG or JPEG regular files; found ${shots.length}. Capture the board, protocol detail and filtered view`);
  }
  if (!existsSync(join(out, 'dashboard', 'index.html'))) throw new Error('dashboard/index.html is required');

  // Last artifact written: the grader reconstructs this dossier from the copied files.
  writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: 65536 }));
  process.stdout.write(`token radar: ${snapshot.protocols.length} protocols; ${board.length} ranked (${radar.watchlist_size} watchlist + ${radar.early_size} early); ${radar.live_size} live; ${dashboardFiles} dashboard files; ${shots.length} screenshots; output ${out}\n`);
}

try { run(); } catch (error) {
  process.stderr.write(`token radar: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
