import { registerHandler } from "@/lib/jobRunner";
import { runDreaming } from "@/lib/dreamHandler";
import { runParseDocument } from "@/lib/parseHandler";
import { runReindexMeeting } from "@/lib/reindexHandler";

// 处理函数的注册入口。
//
// 单独一个模块而不是写在 jobRunner 里：jobRunner 不该认识任何具体功能，否则
// 每加一个任务类型就要改它。各模块在这里登记，jobRunner 只认注册表。
//
// 谁来调：会触发 drain 的入口（目前只有 tick 端点）在干活前调一次。没注册的
// 类型不会被抢走，所以漏调的后果是任务安静地待在队列里，而不是被烧成 failed。

let done = false;

export function registerJobHandlers(): void {
  if (done) return;
  done = true;
  registerHandler("dreaming", runDreaming);
  registerHandler("parse_document", runParseDocument);
  registerHandler("reindex", runReindexMeeting);
}
