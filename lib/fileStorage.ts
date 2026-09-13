import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// 参考文件的原件存本地磁盘。
//
// 为什么留原件而不是只存抽出来的文本：抽取是**有损**的（表格塌成一行、图里的
// 文字丢失、PDF 断行乱掉）。留着原件，解析器改进后可以重抽一遍，用户也能把
// 原文下载回去。文本进数据库（加密），原件进磁盘。
//
// 为什么是本地磁盘而不是对象存储：单机部署（见 plan/phase7-deploy.md），
// 引 OSS 要多一套凭据和网络故障面。`storage_key` 这一层抽象留着，将来换 OSS
// 只需要换掉这个文件。

/** 存储根目录。生产上应该指到数据盘，别放在会被部署覆盖的代码目录里。 */
export function storageRoot(): string {
  return process.env.REFERENCE_STORAGE_DIR ?? path.join(process.cwd(), "storage", "reference-docs");
}

/**
 * 生成 storage key：`<projectId>/<uuid><ext>`。
 *
 * ⚠️ **绝不能用用户传的文件名**。`name` 里可以是 `../../.env`，也可以是
 * Windows 上的 `C:\...` 或者 `CON`/`NUL` 这种保留设备名。用 uuid 就把这一整类
 * 问题从"要仔细过滤"变成"结构上不可能"。原始文件名照样留着，存在
 * `ReferenceDoc.name` 里，只用来显示和下载时做 Content-Disposition。
 *
 * 扩展名保留是为了让磁盘上的文件还能被人直接双击打开，但它也只从白名单字符里取。
 */
export function buildStorageKey(projectId: string, originalName: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(originalName.trim());
  const ext = m ? `.${m[1].toLowerCase()}` : "";
  // projectId 来自数据库主键（uuid），但这里仍然校验一次：这个函数是纯函数，
  // 不该假设调用方传的一定是可信值。
  if (!/^[0-9a-fA-F-]{36}$/.test(projectId)) throw new Error("projectId 不是合法 uuid");
  return `${projectId}/${randomUUID()}${ext}`;
}

/**
 * key → 绝对路径，并确认它确实落在存储根目录里。
 *
 * 第二道防线：key 正常情况下是我们自己生成的，但它存在数据库里，而"数据库里的
 * 值一定是我们写进去的"是个会随时间失效的假设（迁移脚本、手工修数据、将来的
 * 导入功能）。路径穿越的代价是任意文件读写，值得在每次访问时都验一遍。
 */
export function resolveStoragePath(key: string): string {
  const root = path.resolve(storageRoot());
  const full = path.resolve(root, key);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(prefix)) {
    throw new Error(`storage_key 越界：${key}`);
  }
  return full;
}

export async function saveReferenceFile(key: string, data: Uint8Array): Promise<void> {
  const full = resolveStoragePath(key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
}

export async function readReferenceFile(key: string): Promise<Buffer> {
  return readFile(resolveStoragePath(key));
}

/**
 * 删除原件。文件不存在不算错误。
 *
 * 删除顺序是先删数据库行再删文件：反过来的话，文件删了但事务回滚，行还在而
 * 原件没了——那是个无法自愈的状态。反之多一个孤儿文件，占点磁盘，可恢复。
 */
export async function deleteReferenceFile(key: string): Promise<void> {
  if (!key) return;
  try {
    await unlink(resolveStoragePath(key));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
