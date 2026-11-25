// Token Radar, round 4: a working token-radar-01 entry on Node 22, standard library only.
//
// The program reads the sealed snapshot — /input/snapshot.json inside the grader, or the file or
// directory named by --input — scores every pre-token protocol with the radar-2 model from
// lib/model.ts, and writes the ranked board to /output/board.json. It then copies this
// repository's dashboard/ and screenshots/ into /output, and writes /output/dossier.json last,
// the summary the judge reads, using the vendored make.fun library. The dashboard is a static
// page with no framework and no network: dashboard/index.html, dashboard/app.css and
// dashboard/app.js read /output/data.js, which this program writes from the same board.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

/** Where this file lives, so the dashboard and screenshots copy from beside it. */
const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's caps, from reference/gate.json: the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of `--name <value>` (or `--name=<value>`) in the arguments, else the fallback. */
function flagValue(name: string, fallback: string): string {
  const separate = process.argv.indexOf(`--${name}`);
  if (separate >= 0 && separate + 1 < process.argv.length) return process.argv[separate + 1]!;
  const joined = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

/** Fail with a message on stderr and the given exit code. */
function fail(message: string, code: number): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

/** Copy a directory's regular files into `to`, skipping dotfiles, and return the names copied. */
function copyDirectory(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

/** Build the board and write every output file. */
function run(): void {
  const inputLocation = flagValue('input', '/input');
  const snapshotPath = inputLocation.endsWith('.json') ? inputLocation : join(inputLocation, 'snapshot.json');
  if (!existsSync(snapshotPath)) {
    fail(`no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
  }
  const outputDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`, 1);

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

  copyDirectory(join(here, 'dashboard'), join(outputDir, 'dashboard'));
  const shots = copyDirectory(join(here, 'screenshots'), join(outputDir, 'screenshots'));
  if (shots.length < 3) {
    fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`, 1);
  }
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
    }
  }

  // The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
  writeFileSync(
    join(outputDir, 'dossier.json'),
    buildDossier(outputDir, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
  );

  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
      `token radar: wrote ${join(outputDir, 'board.json')}, ${join(outputDir, 'data.js')}, ${join(outputDir, 'dashboard')} (3 files), ${join(outputDir, 'screenshots')} (${shots.length} images) and ${join(outputDir, 'dossier.json')}\n`,
  );
}

run();
