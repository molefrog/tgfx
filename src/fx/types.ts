import type * as acp from "@agentclientprotocol/sdk";

export type FxMirrorMode = "raw" | "timeline" | "collapse";

export type FxAcpEvent =
  | {
      type: "session_started";
      sessionId: string;
      agentName: string;
      agentVersion: string;
      model: string;
      mode: string;
      availableModelCount: number;
    }
  | {
      type: "session_update";
      update: acp.SessionUpdate;
    }
  | {
      type: "permission_requested";
      request: acp.RequestPermissionRequest;
      selectedOptionId?: string;
    }
  | {
      type: "turn_completed";
      stopReason: acp.StopReason;
    };
