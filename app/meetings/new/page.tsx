import MeetingFlow from "@/app/components/MeetingFlow";
import AppShell from "@/app/components/AppShell";
import AppHeader from "@/app/components/AppHeader";

export default function StandaloneMeetingPage() {
  return (
    <AppShell fullHeight>
      <div className="h-full flex flex-col">
        {/* 以前这里是手写的顶栏，所以没有通知铃铛也没有移动端的汉堡。
            加了侧边栏之后所有页面都得能打开抽屉，统一走 AppHeader。 */}
        <AppHeader
          variant="app"
          title={<span className="text-sm font-medium text-tm-1">独立会议</span>}
        />
        <div className="flex-1 overflow-hidden">
          <MeetingFlow />
        </div>
      </div>
    </AppShell>
  );
}
