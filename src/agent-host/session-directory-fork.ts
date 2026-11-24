import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { SessionManager, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import type { ApiParams } from "../contract/api";
import { RpcError } from "../contract/types";
import { validateExistingDirectory } from "./directory-validation";
import { ExecutionLogStore, forkFileIdentity, type ForkHistoryOwnership } from "./execution-log-store";
import { allowFileRoot } from "./file-access";
import { getRpcSession } from "./rpc-manager";
import { sessionIndex } from "./session-index";
import { suspendForkCacheWarming } from "./session-cache-warming";
import { DirectoryForkWorkspace, recoverInterruptedDirectoryForks } from "./session-fork-workspace";
import { buildSessionInfoFromManager, cacheSessionPath, resolveSessionPath } from "./session-reader";
import { readSessionSnapshot } from "./session-readonly";
import { selectSessionShell } from "./session-shell";
import { getDefaultStore } from "./session-tool-store";

function unavailableDirectory() {
  return new RpcError({
    code: "SESSION_FORK_TARGET_UNAVAILABLE",
    message: "The selected folder is unavailable. Choose another folder.",
  });
}

function requireTargetDirectory(cwd: string) {
  const directory = typeof cwd === "string" && path.isAbsolute(cwd) && validateExistingDirectory(cwd);
  if (!directory || !directory.ok) throw unavailableDirectory();
  const stat = fs.statSync(directory.canonicalPath, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw unavailableDirectory();
  return { cwd: directory.canonicalPath, dev: stat.dev, ino: stat.ino };
}

function requireIdle(id: string): void {
  if (getRpcSession(id)?.isRunning())
    throw new RpcError({
      code: "SESSION_FORK_BUSY",
      message: "Wait for the original session to finish before forking it.",
    });
}

function sameRevision(before: BigIntStats | undefined, after: BigIntStats | undefined): boolean {
  if (!before || !after) return before === after;
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function copyConflict() {
  return new RpcError({ code: "CONFLICT", message: "The fork ID or destination is already in use." });
}

function exclusive<T>(claim: () => T): T {
  try {
    return claim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw copyConflict();
    throw error;
  }
}

/** Both inputs to the SDK and the finished transcript are private workspace files. */
function writeTranscript(file: string, header: SessionHeader, entries: readonly SessionEntry[]): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(header) + "\n");
    for (const entry of entries) fs.writeFileSync(fd, JSON.stringify(entry) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

class HardLinksUnavailable extends Error {}

/** Slow fallback I/O runs before the shared permission lock. Only the final header byte is published under it. */
async function publishTranscript(
  prepared: string,
  destination: string,
  workspace: DirectoryForkWorkspace,
  install: (publish: () => void) => Promise<void>,
): Promise<void> {
  try {
    await install(() => {
      try {
        exclusive(() => fs.linkSync(prepared, destination));
      } catch (error) {
        if (
          ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK", "EXDEV"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw new HardLinksUnavailable();
        throw error;
      }
    });
    return;
  } catch (error) {
    if (!(error instanceof HardLinksUnavailable)) throw error;
  }

  // The failed link attempt has already restored its previous policy. A new
  // installation must use the latest document, including concurrent approvals.
  fs.unlinkSync(path.join(workspace.directory, "installing"));
  if (!workspace.ownsDestination()) throw copyConflict();
  const output = await fs.promises.open(destination, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw copyConflict();
    throw error;
  });
  let identity: string | undefined,
    committed = false;
  let writtenRevision: BigIntStats | undefined;
  const ownsName = () => {
    const current = fs.lstatSync(destination, { bigint: true, throwIfNoEntry: false });
    return !!current && forkFileIdentity(current) === identity;
  };
  try {
    identity = forkFileIdentity(await output.stat({ bigint: true }));
    workspace.trackFallback(identity);
    await output.writeFile("!");
    const input = await fs.promises.open(prepared, "r");
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (let offset = 1; ;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        await output.writeFile(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
    } finally {
      await input.close();
    }
    await output.sync();
    writtenRevision = await output.stat({ bigint: true });
    await install(() => {
      if (!ownsName() || !sameRevision(writtenRevision, fs.fstatSync(output.fd, { bigint: true })))
        throw copyConflict();
      fs.writeSync(output.fd, "{", 0, "utf8");
      writtenRevision = fs.fstatSync(output.fd, { bigint: true });
      fs.fsyncSync(output.fd);
      committed = true;
    });
  } finally {
    try {
      await output.close();
    } catch (error) {
      if (!committed) throw error;
      console.warn("[agent-host] could not close a published session fork:", error);
    } finally {
      if (
        !committed &&
        identity &&
        ownsName() &&
        (!writtenRevision ||
          sameRevision(writtenRevision, fs.lstatSync(destination, { bigint: true, throwIfNoEntry: false })))
      )
        fs.unlinkSync(destination);
    }
  }
}

function forkPrivateSnapshot(
  source: SessionManager,
  header: SessionHeader,
  cwd: string,
  workspace: string,
): SessionManager {
  const staging = path.join(workspace, "sdk");
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    // Pi may repair a missing final newline while reading forkFrom's input.
    const snapshot = path.join(staging, "source.snapshot");
    writeTranscript(snapshot, header, source.getEntries());
    return SessionManager.forkFrom(snapshot, cwd, staging);
  } finally {
    // The returned manager already holds the tree in memory.
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function forkSessionToDirectory(params: ApiParams<"sessions.forkToDirectory">) {
  const { id, cwd } = params ?? {};
  if (typeof id !== "string" || !id) throw new RpcError({ code: "BAD_REQUEST", message: "Session ID is required" });
  const target = requireTargetDirectory(cwd);
  await recoverInterruptedDirectoryForks();
  const sourcePath = await resolveSessionPath(id);
  if (!sourcePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
  requireIdle(id);
  const sourceStat = fs.statSync(sourcePath, { bigint: true });
  const source = readSessionSnapshot(sourcePath, {
    strictJson: true,
    confirmedIncompleteTail: params.confirmedIncompleteTail,
  });
  const sourceHeader = source.getHeader();
  if (sourceHeader?.id !== id)
    throw new RpcError({ code: "CONFLICT", message: "The source file no longer matches this session." });
  const sourceHistory = new ExecutionLogStore(id);
  const journalStat = sourceHistory.journalStat();
  const workspace = new DirectoryForkWorkspace();
  const resumeWarming = suspendForkCacheWarming(id);
  let ownedHistory: { store: ExecutionLogStore; ownership: ForkHistoryOwnership } | undefined;
  let published = false;
  let retainForRecovery = false;
  try {
    const fork = forkPrivateSnapshot(source, sourceHeader, target.cwd, workspace.directory);
    const forkId = fork.getSessionId(),
      stagedPath = fork.getSessionFile(),
      header = fork.getHeader();
    if (!header || !stagedPath) throw new Error("Session fork did not produce a valid file");
    if (forkId.toLowerCase() === id.toLowerCase()) throw copyConflict();
    // IDs own resources across project directories. Claim once across the whole
    // sessions root, and keep the claim until all rollback work has finished.
    const root = sessionIndex.sessionsRoot();
    const sessionDirectory = process.env.PI_CODING_AGENT_SESSION_DIR
      ? root
      : SessionManager.create(target.cwd).getSessionDir();
    const sessionPath = path.join(sessionDirectory, path.basename(stagedPath));
    exclusive(() => workspace.claim(forkId, id, sessionPath));
    if (getRpcSession(forkId) || (await resolveSessionPath(forkId))) throw copyConflict();
    const history = new ExecutionLogStore(forkId);
    const claimHistory = exclusive(() => history.reserveForkTarget());
    ownedHistory = { store: history, ownership: claimHistory };
    workspace.trackHistory(claimHistory);
    const entries = fork.getEntries();
    await sourceHistory.copyBranch(forkId, new Set(entries.map((entry) => entry.id)));

    const info = await buildSessionInfoFromManager(sessionPath, fork, entries, { cachePath: false });
    if (!info) throw new Error("Session fork did not produce a valid header");
    const pendingPath = path.join(workspace.directory, "transcript.pending");
    const forkHeader = { ...header, parentSession: sourcePath, piDesktopFork: "directory" };
    writeTranscript(pendingPath, forkHeader, entries);

    const { shell } = selectSessionShell({ isNew: true, toolNames: [] });
    const beforePublish = () => {
      requireIdle(id);
      if (
        !sameRevision(sourceStat, fs.statSync(sourcePath, { bigint: true, throwIfNoEntry: false })) ||
        !sameRevision(journalStat, sourceHistory.journalStat())
      ) {
        throw new RpcError({
          code: params.confirmedIncompleteTail === undefined ? "CONFLICT" : "SESSION_FORK_SOURCE_CHANGED",
          message: "The original session changed while it was being copied. Try again.",
        });
      }
      const current = requireTargetDirectory(cwd);
      if (current.cwd !== target.cwd || current.dev !== target.dev || current.ino !== target.ino)
        throw unavailableDirectory();
      if (!workspace.ownsDestination() || !history.ownsForkTarget(claimHistory)) throw copyConflict();
    };
    await publishTranscript(pendingPath, sessionPath, workspace, (publish) =>
      getDefaultStore().publishChatOnlyFork(
        forkId,
        shell,
        () => {
          beforePublish();
          publish();
          published = true;
        },
        workspace.directory,
      ),
    );
    cacheSessionPath(forkId, sessionPath);
    allowFileRoot(target.cwd);
    return { ...info, parentSessionId: id };
  } catch (error) {
    retainForRecovery = error instanceof AggregateError;
    if (ownedHistory && !published) {
      try {
        ownedHistory.store.rollbackForkTarget(ownedHistory.ownership);
      } catch (rollbackError) {
        retainForRecovery = true;
        throw new AggregateError([error, rollbackError], "Could not roll back the fork's execution history.");
      }
    }
    throw error;
  } finally {
    resumeWarming();
    try {
      workspace.finish(retainForRecovery, published);
    } catch (error) {
      console.warn("[agent-host] failed to remove a private session fork workspace:", error);
    }
  }
}
