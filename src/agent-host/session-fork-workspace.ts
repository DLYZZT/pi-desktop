import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { directoryForkWorkspaceRoot } from "./desktop-data-root";
import { ExecutionLogStore, forkFileIdentity, type ForkHistoryOwnership } from "./execution-log-store";
import { sessionExistsInStores, sessionIndex } from "./session-index";
import { getDefaultStore } from "./session-tool-store";
import { readSessionFileHeader } from "./session-readonly";

const hostPrefix = createHash("sha256").update(hostname()).digest("hex").slice(0, 16) + "-";
const ownerName = /^(v2|[a-f0-9]{16})-(\d+)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

interface ForkIntent {
  root: string;
  rootIdentity?: string;
  source: string;
  id: string;
  relativeFile: string;
  history?: ForkHistoryOwnership;
  fallbackIdentity?: string;
}

function intentFile(directory: string): string {
  return path.join(directory, "intent.json");
}

function claimFile(intent: ForkIntent): string {
  return path.join(intent.root, `.pi-directory-fork-${intent.id.toLowerCase()}.pending`);
}

function ownsClaim(intent: ForkIntent, directory: string): boolean {
  const file = claimFile(intent);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return (
    !!stat?.isFile() &&
    stat.size === Buffer.byteLength(path.basename(directory)) &&
    fs.readFileSync(file, "utf8") === path.basename(directory)
  );
}

function discard(directory: string, intent?: ForkIntent): void {
  if (intent && ownsClaim(intent, directory)) fs.unlinkSync(claimFile(intent));
  fs.rmSync(directory, { recursive: true, force: true });
}

/** A configuration change can point at a different store or at the same store after a rename. */
function locateRoot(intent: ForkIntent): ForkIntent | undefined {
  if (typeof intent.root !== "string" || !path.isAbsolute(intent.root) || path.resolve(intent.root) !== intent.root)
    return;
  for (const root of new Set([intent.root, sessionIndex.sessionsRoot()])) {
    const stat = fs.statSync(root, { bigint: true, throwIfNoEntry: false });
    if (!stat?.isDirectory()) continue;
    if (intent.rootIdentity ? forkFileIdentity(stat) === intent.rootIdentity : root === intent.root)
      return { ...intent, root };
  }
}

/** The private workspace lives on the permission store's volume for atomic restoration. */
export class DirectoryForkWorkspace {
  readonly directory: string;
  private intent?: ForkIntent;
  private claimed = false;
  private readonly release: () => void;

  constructor() {
    const root = directoryForkWorkspaceRoot();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.directory = path.join(root, "v2-" + process.pid + "-" + randomUUID());
    // Acquire before the workspace becomes visible. The lease also protects a
    // live owner on a shared volume, independently of its host name or PID.
    this.release = lockfile.lockSync(this.directory, { realpath: false });
    try {
      fs.mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) {
      this.release();
      throw error;
    }
  }

  claim(id: string, source: string, file: string): void {
    const root = sessionIndex.sessionsRoot();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const intent = {
      root,
      rootIdentity: forkFileIdentity(fs.statSync(root, { bigint: true })),
      source,
      id,
      relativeFile: path.relative(root, file),
    };
    this.save(intent);
    fs.writeFileSync(claimFile(intent), path.basename(this.directory), { mode: 0o600, flag: "wx", flush: true });
    this.claimed = true;
  }

  ownsDestination(): boolean {
    const intent = this.intent;
    return (
      !!intent &&
      intent.root === sessionIndex.sessionsRoot() &&
      locateRoot(intent)?.root === intent.root &&
      ownsClaim(intent, this.directory)
    );
  }

  trackHistory(history: ForkHistoryOwnership): void {
    this.save({ ...this.intent!, history });
  }
  trackFallback(fallbackIdentity: string): void {
    this.save({ ...this.intent!, fallbackIdentity });
  }

  private save(intent: ForkIntent): void {
    const next = path.join(this.directory, "intent.next");
    fs.writeFileSync(next, JSON.stringify(intent), { mode: 0o600, flush: true });
    fs.renameSync(next, intentFile(this.directory));
    this.intent = intent;
  }

  finish(retain = false, published = false): void {
    try {
      if (!retain) {
        const located = this.claimed && this.intent ? locateRoot(this.intent) : undefined;
        if (!published && located?.fallbackIdentity && ownsClaim(located, this.directory)) {
          const destination = checkedDestination(located);
          if (!destination) return;
          hasPublishedTranscript(destination, located, true);
        }
        if (located || !this.claimed) discard(this.directory, located);
      }
    } finally {
      this.release();
    }
  }
}

function pidIsGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function checkedDestination(intent: ForkIntent): string | undefined {
  const root = intent.root;
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    root !== path.resolve(root) ||
    typeof intent.source !== "string" ||
    typeof intent.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(intent.id) ||
    intent.id.toLowerCase() === intent.source.toLowerCase() ||
    typeof intent.relativeFile !== "string" ||
    path.isAbsolute(intent.relativeFile) ||
    intent.relativeFile.split(path.sep).includes("..") ||
    !path.basename(intent.relativeFile).endsWith("_" + intent.id + ".jsonl")
  )
    return;
  const destination = path.join(root, intent.relativeFile);
  // A removed project subdirectory is an ordinary interrupted-copy case.
  // Validate its nearest existing ancestor, including symlink containment.
  let parent = path.dirname(destination);
  while (parent !== root && !fs.lstatSync(parent, { throwIfNoEntry: false })) parent = path.dirname(parent);
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(parent));
  return path.isAbsolute(relative) || relative.split(path.sep).includes("..") ? undefined : destination;
}

function hasPublishedTranscript(destination: string, intent: ForkIntent, removePartial = false): boolean {
  const stat = fs.lstatSync(destination, { bigint: true, throwIfNoEntry: false });
  if (!stat) return false;
  const publishedHeader = () => {
    const header = stat.isFile() && readSessionFileHeader(destination);
    if (!header)
      throw Object.assign(new Error("The occupied fork destination cannot be identified yet"), { code: "EAGAIN" });
    return header.id === intent.id;
  };
  // A partial file on a volume without hard links is removable only with both
  // its recorded identity and the still-unpublished header. Preserve other files.
  if (!stat.isFile() || forkFileIdentity(stat) !== intent.fallbackIdentity) {
    // An identifiable file owned by another session must survive our rollback.
    return publishedHeader();
  }
  const fd = fs.openSync(
    destination,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    if (forkFileIdentity(fs.fstatSync(fd, { bigint: true })) !== intent.fallbackIdentity) return true;
    const first = Buffer.alloc(1);
    if (fs.readSync(fd, first, 0, 1, 0) && first[0] !== 0x21) return publishedHeader();
  } finally {
    fs.closeSync(fd);
  }
  const stillOwned = fs.lstatSync(destination, { bigint: true, throwIfNoEntry: false });
  if (!stillOwned) return false;
  if (forkFileIdentity(stillOwned) !== intent.fallbackIdentity) return true;
  if (removePartial) fs.unlinkSync(destination);
  return false;
}

async function recoverOne(directory: string, waitForStale: boolean): Promise<void> {
  const release = await lockfile.lock(directory, {
    realpath: false,
    retries: waitForStale ? { retries: 24, minTimeout: 500, maxTimeout: 500 } : 0,
  });
  try {
    if (!fs.existsSync(directory)) return;
    const file = intentFile(directory);
    if (!fs.existsSync(file)) {
      discard(directory);
      return;
    }
    const recorded: ForkIntent = JSON.parse(fs.readFileSync(file, "utf8"));
    const installing = fs.existsSync(path.join(directory, "installing"));
    const locate = () => {
      const intent = locateRoot(recorded);
      if (!intent) return;
      const destination = checkedDestination(intent);
      if (destination) return { intent, destination, currentRoot: sessionIndex.sessionsRoot() };
    };
    type Location = NonNullable<ReturnType<typeof locate>>;
    const unpublished = ({ intent, destination }: Location) => {
      const prepared = fs.statSync(path.join(directory, "transcript.pending"), { throwIfNoEntry: false });
      return (
        ownsClaim(intent, directory) &&
        !hasPublishedTranscript(destination, intent) &&
        !(prepared && prepared.nlink > 1)
      );
    };
    const decide = async () => {
      const location = locate();
      if (!location) return;
      const rollback =
        unpublished(location) &&
        (!installing ||
          !(await sessionExistsInStores([location.intent.root, location.currentRoot], location.intent.id)));
      return { ...location, rollback };
    };
    const finish = (decision: Awaited<ReturnType<typeof decide>>) => {
      if (!decision) return;
      const latest = locate();
      if (!latest || latest.intent.root !== decision.intent.root || latest.currentRoot !== decision.currentRoot) return;
      const { intent, destination } = latest;
      if (decision.rollback && unpublished(latest)) {
        const ours = !installing || getDefaultStore().rollbackUnpublishedFork(intent.id, directory);
        if (ours && intent.history) new ExecutionLogStore(intent.id).rollbackForkTarget(intent.history);
      }
      if (intent.fallbackIdentity && ownsClaim(intent, directory)) hasPublishedTranscript(destination, intent, true);
      discard(directory, intent);
    };
    if (installing) await getDefaultStore().writeLock.prepareThenRun(decide, finish);
    else finish(await decide());
  } finally {
    await release();
  }
}

let recovery: Promise<void> | undefined;

export function recoverInterruptedDirectoryForks(): Promise<void> {
  if (recovery) return recovery;
  recovery = (async () => {
    const root = directoryForkWorkspaceRoot();
    if (!fs.existsSync(root)) return;
    const owners = new Set(
      fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name.replace(/\.lock$/, "")),
    );
    const localVolume = fs.statSync(root).dev === fs.statSync(tmpdir()).dev;
    for (const name of owners) {
      const owner = ownerName.exec(name);
      if (!owner) continue;
      const gone = pidIsGone(Number(owner[2]));
      if (localVolume && !gone) continue;
      if (owner[1] !== "v2") {
        // Legacy workspaces had no lifetime lease. A renamed host can still
        // identify dead local PIDs on the same device as its local temp dir.
        if (!gone || (owner[1] + "-" !== hostPrefix && !localVolume)) continue;
      }
      try {
        await recoverOne(path.join(root, name), owner[1] === "v2" && gone);
      } catch (error) {
        if (
          !["ELOCKED", "ENOENT", "ENOTDIR", "EAGAIN", "SESSION_HEADER_LIMIT"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          console.warn("[agent-host] could not reconcile an interrupted directory fork:", error);
      }
    }
  })().finally(() => {
    recovery = undefined;
  });
  return recovery;
}
