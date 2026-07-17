import type { Approval, ProfitFlywheelFactoryHealth, ProfitFlywheelFactoryWorkflowDetail } from "@paperclipai/shared";
import { profitFlywheelFactoryHealthSchema, profitFlywheelFactoryWorkflowDetailSchema } from "@paperclipai/shared";
import { api } from "./client";

export const profitFlywheelApi = {
  async factoryHealth(companyId: string): Promise<ProfitFlywheelFactoryHealth> {
    const value = await api.get<unknown>(`/companies/${companyId}/profit-flywheel/factory-health`);
    return profitFlywheelFactoryHealthSchema.parse(value);
  },
  async factoryWorkflow(companyId: string, workflowId: string): Promise<ProfitFlywheelFactoryWorkflowDetail> {
    const value = await api.get<unknown>(`/companies/${companyId}/profit-flywheel/factory-workflows/${workflowId}`);
    return profitFlywheelFactoryWorkflowDetailSchema.parse(value);
  },
  async pauseFactory(companyId: string): Promise<ProfitFlywheelFactoryHealth> {
    const value = await api.post<unknown>(`/companies/${companyId}/profit-flywheel/factory-pause`, { confirm: true });
    return profitFlywheelFactoryHealthSchema.parse(value);
  },
  async createFactoryLaunchProposal(companyId: string, input: {
    requestedMode: "shadow" | "production";
    targetRepo: string;
    runId: string;
    inputHash: string;
    workflowId?: string;
    expiresInSeconds?: number;
  }): Promise<Approval> {
    return api.post<Approval>(`/companies/${companyId}/profit-flywheel/factory-launch-proposals`, input);
  },
  async resumeFactoryStage(input: {
    stageRunId: string;
    inputHash: string;
    expectedBlockerCode: string;
    expectedReceiptId: string;
    expectedReceiptHash: string;
  }): Promise<unknown> {
    return api.post(`/profit-flywheel/stages/${input.stageRunId}/resume`, {
      inputHash: input.inputHash,
      expectedBlockerCode: input.expectedBlockerCode,
      expectedReceiptId: input.expectedReceiptId,
      expectedReceiptHash: input.expectedReceiptHash,
    });
  },
};
