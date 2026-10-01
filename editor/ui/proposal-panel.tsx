import { For, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { EditProposal, ProposalAssessment } from "../proposals/types.ts";
import { HEADER_H, PAL_W } from "../engine/layout.ts";
import {
  createProposalPanelLayout,
  proposalActionRects,
  proposalRowRect,
  proposalVisibleRows,
} from "../engine/proposal-layout.ts";
import { ACCENT, BAD, BUTTON, BUTTON_ON, DIM, GOOD, INK, PANEL } from "./panels.tsx";
import { fitEditorText, wrapEditorText } from "./text-fit.ts";

export function ProposalPanel(props: {
  proposals: EditProposal[];
  assessments: ProposalAssessment[];
  selectedProposal: number | null;
  selectedHunk: number;
  scroll: number;
  panelH: number;
  agent: {
    available: boolean;
    adapter: string;
    message: string;
    input: string;
    focused: boolean;
    running: boolean;
  };
}): JSX.Element {
  const proposal = () => props.selectedProposal === null ? null : props.proposals[props.selectedProposal] ?? null;
  const assessment = () => props.selectedProposal === null ? null : props.assessments[props.selectedProposal] ?? null;
  const visible = () => proposalVisibleRows(props.panelH, proposal() !== null, proposal() === null);
  const rows = () => proposal()
    ? proposal()!.hunks.slice(props.scroll, props.scroll + visible())
    : props.proposals.slice(props.scroll, props.scroll + visible());
  const actions = () => proposalActionRects(props.panelH);
  const layout = () => createProposalPanelLayout(props.panelH, proposal() ? "detail" : "compose");
  const agentLayout = () => layout().agent!;

  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: 0, insetT: HEADER_H, width: PAL_W, height: props.panelH, bgColor: PANEL, overflow: 1 }}
      debugName="editor-proposal-panel"
    >
      <Show when={proposal()} fallback={
        <>
          <Text class="absolute text-xs" style={{
            posType: 1,
            insetL: agentLayout().heading.x,
            insetT: agentLayout().heading.y,
            width: agentLayout().heading.w,
            textColor: ACCENT,
            height: agentLayout().heading.h,
            lineHeight: 12,
          }}>
            {fitEditorText("ASK LOCAL AGENT", agentLayout().heading.w)}
          </Text>
          <View
            class="absolute"
            style={{
              posType: 1,
              insetL: agentLayout().input.x,
              insetT: agentLayout().input.y,
              width: agentLayout().input.w,
              height: agentLayout().input.h,
              bgColor: "#111722",
              borderWidth: 1,
              borderColor: props.agent.focused ? ACCENT : "#3a4458",
            }}
            debugName="editor-agent-input"
          >
            <Text class="absolute text-xs" style={{
              posType: 1,
              insetL: 3,
              insetT: 3,
              width: Math.max(0, agentLayout().input.w - 6),
              height: Math.max(0, agentLayout().input.h - 6),
              lineHeight: 10,
              textColor: props.agent.input ? INK : DIM,
            }}>
              {wrapEditorText(
                props.agent.input || "Describe what to change",
                Math.max(0, agentLayout().input.w - 6),
                Math.max(1, Math.floor((agentLayout().input.h - 6) / 10)),
              ).join("\n")}
            </Text>
          </View>
          <View
            class="absolute flex-row items-center justify-center"
            style={{
              posType: 1,
              insetL: agentLayout().action.x,
              insetT: agentLayout().action.y,
              width: agentLayout().action.w,
              height: agentLayout().action.h,
              bgColor: props.agent.running ? "#55352a" : BUTTON,
              opacity: props.agent.running || (props.agent.available && props.agent.input.trim().length > 0) ? 1 : 0.45,
            }}
            debugName={props.agent.running ? "editor-agent-cancel" : "editor-agent-run"}
          >
            <Text class="text-xs" style={{ textColor: props.agent.running ? "#ffd0b8" : INK, height: 10, lineHeight: 10 }}>
              {fitEditorText(
                props.agent.running ? "CANCEL" : `RUN ${props.agent.adapter.toUpperCase()}`,
                Math.max(0, agentLayout().action.w - 8),
              )}
            </Text>
          </View>
          <Text class="absolute text-xs" style={{
            posType: 1,
            insetL: agentLayout().status.x,
            insetT: agentLayout().status.y,
            width: agentLayout().status.w,
            textColor: props.agent.available ? DIM : BAD,
            height: agentLayout().status.h,
            lineHeight: 10,
          }}>
            {wrapEditorText(
              props.agent.message,
              agentLayout().status.w,
              Math.max(1, Math.floor(agentLayout().status.h / 10)),
            ).join("\n")}
          </Text>
          <Text class="absolute text-xs" style={{
            posType: 1,
            insetL: agentLayout().proposalHeading.x,
            insetT: agentLayout().proposalHeading.y,
            width: agentLayout().proposalHeading.w,
            textColor: ACCENT,
            height: agentLayout().proposalHeading.h,
            lineHeight: 10,
          }}>
            {fitEditorText(`PROPOSALS (${props.proposals.length})`, agentLayout().proposalHeading.w)}
          </Text>
          <Show when={props.proposals.length === 0}>
            <Text class="absolute text-xs" style={{ posType: 1, insetL: 5, insetT: layout().listClip.y + 5, width: 130, textColor: DIM, height: 24, lineHeight: 11 }}>
              NO PENDING{"\n"}PROPOSALS
            </Text>
          </Show>
          <For each={rows() as EditProposal[]}>
            {(item, row) => {
              const index = () => props.scroll + row();
              const rect = () => proposalRowRect(row(), false, true);
              const conflict = () => props.assessments[index()]?.hasConflicts === true;
              const pending = () => item.hunks.filter((hunk) => !hunk.decision).length;
              return (
                <View
                  class="absolute"
                  style={{
                    posType: 1, insetL: rect().x, insetT: rect().y, width: rect().w, height: rect().h,
                    bgColor: conflict() ? "#4a2428" : BUTTON,
                    borderWidth: 1,
                    borderColor: conflict() ? BAD : "#3a4458",
                  }}
                  debugName={`editor-proposal-${item.id}`}
                >
                  <Text class="absolute text-xs" style={{ posType: 1, insetL: 3, insetT: 2, width: 125, textColor: INK, height: 10, lineHeight: 10 }}>
                    {fitEditorText(item.title, 125)}
                  </Text>
                  <Text class="absolute text-xs" style={{ posType: 1, insetL: 3, insetT: 15, width: 125, textColor: conflict() ? BAD : DIM, height: 10, lineHeight: 10 }}>
                    {fitEditorText(`${item.author} · ${pending()}/${item.hunks.length}${conflict() ? " CONFLICT" : ""}`, 125)}
                  </Text>
                </View>
              );
            }}
          </For>
        </>
      }>
        {(selected) => (
          <>
            <View
              class="absolute flex-row items-center justify-center"
              style={{ posType: 1, insetL: actions()[0]!.rect.x, insetT: actions()[0]!.rect.y, width: actions()[0]!.rect.w, height: actions()[0]!.rect.h, bgColor: BUTTON }}
              debugName="editor-proposal-back"
            >
              <Text class="text-xs" style={{ textColor: INK, height: 10, lineHeight: 10 }}>BACK</Text>
            </View>
            <Text class="absolute text-xs" style={{ posType: 1, insetL: 50, insetT: 6, width: 85, textColor: ACCENT, height: 11, lineHeight: 11 }}>
              {fitEditorText(selected().title, 85)}
            </Text>
            <Text class="absolute text-xs" style={{ posType: 1, insetL: 5, insetT: 26, width: 130, textColor: DIM, height: 11, lineHeight: 11 }}>
              {fitEditorText(`BY ${selected().author}`, 130)}
            </Text>
            <Text class="absolute text-xs" style={{ posType: 1, insetL: 5, insetT: 42, width: 130, textColor: INK, height: 32, lineHeight: 10 }}>
              {wrapEditorText(selected().rationale, 130, 3).join("\n")}
            </Text>
            <Text class="absolute text-xs" style={{ posType: 1, insetL: 5, insetT: 75, width: 130, textColor: DIM, height: 10, lineHeight: 10 }}>
              HUNKS
            </Text>
            <For each={rows() as EditProposal["hunks"]}>
              {(hunk, row) => {
                const index = () => props.scroll + row();
                const rect = () => proposalRowRect(row(), true);
                const state = () => assessment()?.hunks[index()]?.state ?? "conflict";
                const decision = () => hunk.decision?.status;
                const color = () => decision() === "accepted" ? GOOD : decision() === "rejected" ? BAD : state() === "clean" ? INK : BAD;
                return (
                  <View
                    class="absolute"
                    style={{
                      posType: 1, insetL: rect().x, insetT: rect().y, width: rect().w, height: rect().h,
                      bgColor: index() === props.selectedHunk ? BUTTON_ON : BUTTON,
                      borderWidth: index() === props.selectedHunk ? 1 : 0,
                      borderColor: ACCENT,
                    }}
                    debugName={`editor-proposal-hunk-${hunk.id}`}
                  >
                    <Text class="absolute text-xs" style={{ posType: 1, insetL: 3, insetT: 2, width: 126, textColor: color(), height: 10, lineHeight: 10 }}>
                      {fitEditorText(`${index() + 1}. ${hunk.summary}`, 126)}
                    </Text>
                    <Text class="absolute text-xs" style={{ posType: 1, insetL: 3, insetT: 14, width: 126, textAlign: 2, textColor: color(), height: 9, lineHeight: 9 }}>
                      {decision()?.toUpperCase() ?? state().toUpperCase()}
                    </Text>
                  </View>
                );
              }}
            </For>
            <For each={actions().slice(1)}>
              {(item) => {
                const label = item.action.kind === "accept" ? "ACCEPT" : item.action.kind === "reject" ? "REJECT" : "ACCEPT ALL";
                const selectedHunk = () => selected().hunks[props.selectedHunk];
                const enabled = () => item.action.kind === "accept-all"
                  ? selected().hunks.some((hunk, index) => !hunk.decision &&
                      ["clean", "already-applied"].includes(assessment()?.hunks[index]?.state ?? "conflict"))
                  : !!selectedHunk() && !selectedHunk()!.decision &&
                    (item.action.kind === "reject" ||
                      ["clean", "already-applied"].includes(assessment()?.hunks[props.selectedHunk]?.state ?? "conflict"));
                return (
                  <View
                    class="absolute flex-row items-center justify-center"
                    style={{
                      posType: 1, insetL: item.rect.x, insetT: item.rect.y, width: item.rect.w, height: item.rect.h,
                      bgColor: BUTTON, opacity: enabled() ? 1 : 0.4,
                    }}
                    debugName={`editor-proposal-${item.action.kind}`}
                  >
                    <Text class="text-xs" style={{ textColor: enabled() ? INK : DIM, height: 10, lineHeight: 10 }}>{label}</Text>
                  </View>
                );
              }}
            </For>
          </>
        )}
      </Show>
      <Text class="absolute text-xs" style={{
        posType: 1,
        insetL: layout().footer.x,
        insetT: layout().footer.y,
        width: layout().footer.w,
        textColor: DIM,
        height: layout().footer.h,
        lineHeight: 10,
      }}>
        {proposal() ? "SELECT HUNK\nTO LOCATE" : "SELECT PROPOSAL\nTO REVIEW"}
      </Text>
    </View>
  );
}
