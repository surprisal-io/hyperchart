/** @vitest-environment jsdom */
import { renderHook, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useVisitSessionReader, type RuntimeHistoryContext } from "../packages/hyperchart/src/react/components/inspector/details/RuntimeSection.js";
import type { HyperchartInspectorDataSource } from "../packages/hyperchart/src/host/adapter.js";
afterEach(cleanup);
it("shares the exact session promise and never sends the invocation origin as the selected branch", async () => {
 const readVisitSession=vi.fn().mockResolvedValue({actionKey:"chart:generate:agent",status:"completed"});
 const history: RuntimeHistoryContext={runId:"run",snapshot:{branchId:"child",headSeqId:100},dataSource:{readVisitSession} as unknown as HyperchartInspectorDataSource};
 const {result,rerender}=renderHook(({context})=>useVisitSessionReader(context),{initialProps:{context:history}});
 const top=result.current!(20); const lower=result.current!(20,"parent");
 expect(top).toBe(lower); await top;
 expect(readVisitSession).toHaveBeenCalledExactlyOnceWith({runId:"run",snapshot:history.snapshot,invokeSeqId:20});
 rerender({context:{...history,snapshot:{branchId:"child",headSeqId:101}}});
 expect(result.current!(20)).not.toBe(top);
 expect(readVisitSession).toHaveBeenCalledTimes(2);
});
it("does not retain rejected reads", async () => {
 const readVisitSession=vi.fn().mockRejectedValueOnce(new Error("retry")).mockResolvedValue(undefined);
 const context: RuntimeHistoryContext={runId:"run",snapshot:{branchId:"main",headSeqId:10},dataSource:{readVisitSession} as unknown as HyperchartInspectorDataSource};
 const {result}=renderHook(()=>useVisitSessionReader(context));
 await expect(result.current!(5)).rejects.toThrow("retry");
 await expect(result.current!(5)).resolves.toBeUndefined();
 expect(readVisitSession).toHaveBeenCalledTimes(2);
});
