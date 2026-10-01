import { For, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { EditProposal, ProposalAssessment } from "../proposals/types.ts";
import {
  proposalActionRects,
  proposalRowRect,
  proposalVisibleRows,
} from "../engine/proposal-layout.ts";
import { ACCENT, BAD, BUTTON, BUTTON_ON, DIM, GOOD, INK, PANEL } from "./panels.tsx";

function clipped(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, Math.max(1, length - 1))}…`;
}

export function ProposalPanel(props: {
  proposals: EditProposal[];
  assessments: ProposalAssessment[];
  selectedProposal: number | null;
  selectedHunk: number;
  scroll: number;
  panelH: number;
}): JSX.Element {
  const proposal = () => props.selectedProposal === null ? null : props.proposals[props.selectedProposal] ?? null;
  const assessment = () => props.selectedProposal === null ? null : props.assessments[props.selectedProposal] ?? null;
  const visible = () => proposalVisibleRows(props.panelH, proposal() !== null);
  const rows = () => proposal()
    ? proposal()!.hunks.slice(props.scroll, props.scroll + visible())
    : props.proposals.slice(props.scroll, props.scroll + visible());
  const actions = () => proposalActionRects(props.panelH);

  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: 0, insetT: 20, width: 140, height: props.panelH, bgColor: PANEL, overflow: 1 }}
      debugName="editor-proposal-panel"
    >
      <Show when={proposal()} fallback={
        <>
          <Text class="absolute text-xs" style={{ posType: 1, insetL: 5, insetT: 5, textColor: ACCENT, height: 12, lineHeight: 12 }}>
            PROPOSALS ({props.proposals.length})
          </Text>
          <Show when={props.proposals.length === 0}>
            <Text class="absolute text-xs" style={{ posType: 1, insetL: 5, insetT: 34, width: 130, textColor: DIM, height: 24, lineHeight: 11 }}>
              NO PENDING{"\n"}PROPOSALS
            </Text>
          </Show>
          <For each={rows() as EditProposal[]}>
            {(item, row) => {
              const index = () => props.scroll + row();
              const rect = () => proposalRowRect(row(), false);
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
                    {clipped(item.title, 20)}
                  </Text>
                  <Text class="absolute text-xs" style={{ posType: 1, insetL: 3, insetT: 15, width: 125, textColor: conflict() ? BAD : DIM, height: 10, lineHeight: 10 }}>
                    {clipped(`${item.author} · ${pending()}/${item.hunks.length}${conflict() ? " CONFLICT" : ""}`, 24)}
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
              {clipped(selected().title, 13)}
            </Text>
            <Text class="absolute text-xs" style={{ posType: 1, insetL: 5, insetT: 26, width: 130, textColor: DIM, height: 11, lineHeight: 11 }}>
              BY {clipped(selected().author, 18)}
            </Text>
            <Text class="absolute text-xs" style={{ posType: 1, insetL: 5, insetT: 42, width: 130, textColor: INK, height: 32, lineHeight: 10 }}>
              {clipped(selected().rationale, 58)}
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
                    <Text class="absolute text-xs" style={{ posType: 1, insetL: 3, insetT: 2, width: 125, textColor: color(), height: 10, lineHeight: 10 }}>
                      {clipped(`${index() + 1}. ${hunk.summary}`, 21)}
                    </Text>
                    <Text class="absolute text-xs" style={{ posType: 1, insetL: 3, insetT: 12, width: 125, textColor: color(), height: 9, lineHeight: 9 }}>
                      {decision()?.toUpperCase() ?? state().toUpperCase()}
                    </Text>
                  </View>
                );
              }}
            </For>
            <For each={actions().slice(1)}>
              {(item) => {
                const label = item.action.kind === "accept" ? "ACCEPT" : item.action.kind === "reject" ? "REJECT" : "ALL";
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
      <Text class="absolute text-xs" style={{ posType: 1, insetL: 5, insetT: props.panelH - 22, width: 130, textColor: DIM, height: 11, lineHeight: 11 }}>
        SELECT HUNK TO LOCATE
      </Text>
    </View>
  );
}
