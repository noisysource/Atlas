// The dataset's nightly copy (#295): each finished day's file goes to the Noisy
// Source Drive, in Atlas/dataset/<who>/, once. Today's file waits for
// tomorrow night, so a day is never copied half-written. Needs Drive with
// writes on for that account (DRIVE_WRITE=on, connected with it); without
// that it says why and copies nothing. What was copied is kept in
// data/dataset/.copied.json; the folders' ids too, so they're found once.

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Dataset } from "./dataset.js";
import type { DriveAccount, DriveClient } from "./drive.js";
import { err, ok, type Result } from "./result.js";
import type { Logger } from "./types.js";

const FOLDER = "application/vnd.google-apps.folder";

/** DATASET_DRIVE: "noisysource:Atlas/dataset" (the account, then the folders under its Drive). */
export const parseDatasetDrive = (v: string | undefined): { readonly account: string; readonly folders: readonly string[] } => {
  const [account, rest] = (v ?? "noisysource:Atlas/dataset").split(":", 2);
  const folders = (rest ?? "Atlas/dataset")
    .split("/")
    .map((f) => f.trim())
    .filter((f) => f !== "" && f.length <= 100 && !/[\\<>]/.test(f));
  return { account: (account ?? "noisysource").trim() || "noisysource", folders: folders.length > 0 ? folders : ["Atlas", "dataset"] };
};

type Kept = { copied: string[]; folders: Record<string, string> };

export const backupDataset = async (deps: {
  readonly dataset: Dataset;
  readonly drive: DriveClient;
  readonly account: DriveAccount;
  readonly folders: readonly string[];
  /** Today, in their time zone: its files aren't finished, so they wait. */
  readonly today: string;
  readonly log?: Logger;
}): Promise<Result<{ readonly copied: number }, string>> => {
  const { drive } = deps;
  const createFolder = drive.createFolder;
  const upload = drive.upload;
  if (!createFolder || !upload) return err("Drive writes are off (DRIVE_WRITE=on, and connect the account with it)");
  const keptFile = path.join(deps.dataset.root, ".copied.json");
  const kept: Kept = await readFile(keptFile, "utf8")
    .then((t) => {
      const v = JSON.parse(t) as Partial<Kept>;
      return { copied: Array.isArray(v.copied) ? v.copied.filter((x) => typeof x === "string") : [], folders: v.folders && typeof v.folders === "object" ? v.folders : {} };
    })
    .catch(() => ({ copied: [], folders: {} }));
  const save = async () => {
    const tmp = `${keptFile}.tmp`;
    await writeFile(tmp, JSON.stringify(kept), { mode: 0o600 });
    await rename(tmp, keptFile);
  };

  /** The folder at this path, found or made. */
  const folderAt = async (names: readonly string[]): Promise<Result<string, string>> => {
    const key = names.join("/");
    const known = kept.folders[key];
    if (known) return ok(known);
    const parentNames = names.slice(0, -1);
    const name = names.at(-1) ?? "";
    let parent = "root";
    if (parentNames.length > 0) {
      const p = await folderAt(parentNames);
      if (!p.ok) return p;
      parent = p.value;
    }
    // The top folder is looked for by name (the Drive's root can hold hundreds); the rest in their parent.
    const found = await drive.list(parentNames.length === 0 ? { account: deps.account, folder: "root", name, max: 25 } : { account: deps.account, folder: parent, max: 25 });
    if (!found.ok) return err(found.error.message);
    const match = found.value.find((f) => f.mimeType === FOLDER && f.name === name);
    const id = match ? match.id : await createFolder({ kind: "folder", account: deps.account, name, parent }).then((r) => (r.ok ? r.value.id : undefined));
    if (!id) return err(`couldn't make the ${name} folder`);
    kept.folders[key] = id;
    return ok(id);
  };

  let copied = 0;
  for (const f of await deps.dataset.files()) {
    const key = `${f.who}/${f.day}`;
    if (f.day >= deps.today || kept.copied.includes(key)) continue;
    const folder = await folderAt([...deps.folders, f.who]);
    if (!folder.ok) {
      await save().catch(() => undefined);
      return err(folder.error);
    }
    const bytes = new Uint8Array(await readFile(f.file));
    const done = await upload({ account: deps.account, folder: folder.value, name: `${f.day}.jsonl`, mimeType: "application/jsonl", bytes });
    if (!done.ok) {
      await save().catch(() => undefined);
      return err(done.error.message);
    }
    kept.copied.push(key);
    copied += 1;
  }
  await save().catch(() => undefined);
  deps.log?.info("dataset copied to Drive", { files: copied });
  return ok({ copied });
};
