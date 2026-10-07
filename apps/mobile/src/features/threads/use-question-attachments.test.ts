import { beforeEach, expect, it, vi } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type UserInputQuestion } from "@t3tools/contracts";
import type {
  DraftComposerAttachment,
  DraftComposerImageAttachment,
} from "../../lib/composerImages";

const fixture = vi.hoisted(
  /** Keep hook refs and attachment boundaries alive between simulated renders. */ () => ({
    refs: [] as Array<{ current: unknown }>,
    refCursor: 0,
    effectCursor: 0,
    effects: [] as Array<{ dependencies: ReadonlyArray<unknown>; cleanup?: () => void }>,
    preparations: {} as Record<string, number>,
    drafts: {} as Record<string, { attachments: ReadonlyArray<DraftComposerAttachment> }>,
    append: vi.fn<() => number>(),
    release: vi.fn<() => Promise<void>>(),
    files: vi.fn<typeof import("../../lib/composerImages").pickComposerFiles>(),
    media: vi.fn<typeof import("../../lib/composerImages").pickComposerMedia>(),
    paste: vi.fn<typeof import("../../lib/composerImages").convertPastedImagesToAttachments>(),
  }),
);

vi.mock(
  "react",
  /** Model persistent refs and dependency-based effect cleanup without rendering native UI. */ () => ({
    /** Commit current props before deferred native attachment work resumes. */
    useLayoutEffect: (callback: () => void) => callback(),
    /** Retain each ref by its hook position across rerenders. */
    useRef: <T>(initial: T) => {
      const index = fixture.refCursor++;
      fixture.refs[index] ??= { current: initial };
      return fixture.refs[index] as { current: T };
    },
    /** Run scope effects only when their dependencies change. */
    useEffect: (callback: () => void | (() => void), dependencies: ReadonlyArray<unknown>) => {
      const index = fixture.effectCursor++;
      const previous = fixture.effects[index];
      if (
        previous &&
        previous.dependencies.length === dependencies.length &&
        dependencies.every(
          /** Compare dependency identity as React does. */ (value, position) =>
            Object.is(value, previous.dependencies[position]),
        )
      )
        return;
      previous?.cleanup?.();
      fixture.effects[index] = { dependencies, cleanup: callback() ?? undefined };
    },
  }),
);
vi.mock(
  "react-native",
  /** Avoid loading native UI for async attachment logic. */ () => ({
    Alert: { alert: vi.fn() },
  }),
);
vi.mock(
  "@effect/atom-react",
  /** Read the current attachment drafts on each render. */ () => ({
    useAtomValue: /** Supply isolated composer state. */ () => fixture.drafts,
  }),
);
vi.mock(
  "../../state/atom-registry",
  /** Store the real preparation atom's reservations in memory. */ () => ({
    appAtomRegistry: {
      get: /** Return either composer drafts or preparation counts. */ (atom: unknown) =>
        atom === "drafts" ? fixture.drafts : fixture.preparations,
      set: /** Persist preparation updates for subsequent async completion checks. */ (
        _atom: unknown,
        preparations: Record<string, number>,
      ) => {
        fixture.preparations = preparations;
      },
    },
  }),
);
vi.mock(
  "../../state/use-composer-drafts",
  /** Observe append and unused-file cleanup boundaries. */ () => ({
    composerDraftsAtom: "drafts",
    appendComposerDraftAttachments: fixture.append,
    releaseUnusedComposerAttachmentFiles: fixture.release,
    removeComposerDraftAttachment: vi.fn(),
  }),
);
vi.mock(
  "../../lib/composerImages",
  /** Defer native work until the test releases its result. */ () => ({
    pickComposerFiles: fixture.files,
    pickComposerMedia: fixture.media,
    convertPastedImagesToAttachments: fixture.paste,
  }),
);
vi.mock(
  "../../state/use-thread-selection",
  /** Keep the same selected thread across renders. */ () => ({
    useThreadSelection: /** Select the isolated fixture's thread. */ () => ({
      selectedThread: { environmentId: "environment-1", id: "thread-1" },
    }),
  }),
);
vi.mock(
  "../../state/entities",
  /** Enable the supported question attachment capability. */ () => ({
    useServerConfigs: /** Provide attachment limits for the selected environment. */ () =>
      new Map([
        [
          "environment-1",
          {
            environment: {
              capabilities: {
                questionAttachments: true,
                fileAttachments: { maxUploadBytes: 20_000_000 },
              },
            },
          },
        ],
      ]),
  }),
);

import { useQuestionAttachments } from "./use-question-attachments";

const question = {
  id: "question-1",
  header: "Evidence",
  question: "Attach evidence",
  options: [],
  allowCustomAnswer: true,
  multiSelect: false,
} satisfies UserInputQuestion;
const image = {
  id: "image-1",
  type: "image",
  name: "evidence.png",
  mimeType: "image/png",
  sizeBytes: 4,
  previewUri: "file:///evidence.png",
  fileUri: "file:///evidence.png",
} satisfies DraftComposerImageAttachment;
const file = {
  id: "file-1",
  type: "file",
  name: "evidence.txt",
  mimeType: "text/plain",
  sizeBytes: 4,
  fileUri: "file:///evidence.txt",
} satisfies DraftComposerAttachment;

/** Rerender the real hook while preserving refs and the same active question. */
function render(disabled = false) {
  fixture.refCursor = 0;
  fixture.effectCursor = 0;
  return useQuestionAttachments({
    requestId: "request-1",
    question,
    questions: [question],
    disabled,
  });
}

/** Begin one native operation and return an explicit completion signal. */
function begin(kind: "files" | "media" | "paste") {
  const hook = render();
  const files = Promise.withResolvers<Awaited<ReturnType<typeof fixture.files>>>();
  const media = Promise.withResolvers<Awaited<ReturnType<typeof fixture.media>>>();
  const paste = Promise.withResolvers<Awaited<ReturnType<typeof fixture.paste>>>();
  fixture.files.mockReturnValue(files.promise);
  fixture.media.mockReturnValue(media.promise);
  fixture.paste.mockReturnValue(paste.promise);
  const result = kind === "files" ? [file] : [image];
  const completion =
    kind === "files"
      ? hook.onPickFiles()
      : kind === "media"
        ? hook.onPickMedia()
        : hook.onPasteImages([image.fileUri]);
  return {
    key: hook.key,
    result,
    completion,
    /** Finish the pending picker or conversion without timers or polling. */
    resolve: () => {
      if (kind === "files") files.resolve({ files: [file], error: null });
      else if (kind === "media") media.resolve({ attachments: [image], error: null });
      else paste.resolve([image]);
    },
  };
}

beforeEach(
  /** Reset isolated hook state and native boundaries before each race. */ () => {
    vi.clearAllMocks();
    fixture.refs = [];
    fixture.effects = [];
    fixture.preparations = {};
    fixture.drafts = {};
    fixture.append.mockReturnValue(0);
    fixture.release.mockResolvedValue(undefined);
  },
);

it.each(["files", "media", "paste"] as const)(
  "releases late %s results when the same question becomes disabled",
  /** Disable the same question before deferred native work finishes. */ async (kind) => {
    const operation = begin(kind);
    expect(fixture.preparations[operation.key]).toBe(1);
    render(true);
    operation.resolve();
    await operation.completion;
    expect(fixture.append).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(operation.result);
    expect(fixture.preparations[operation.key]).toBe(0);
  },
);

it.each(["files", "media", "paste"] as const)(
  "appends %s results when the same question remains enabled",
  /** Preserve successful completion across an ordinary enabled rerender. */ async (kind) => {
    const operation = begin(kind);
    expect(fixture.preparations[operation.key]).toBe(1);
    render();
    operation.resolve();
    await operation.completion;
    expect(fixture.append).toHaveBeenCalledExactlyOnceWith(operation.key, operation.result, {
      maxAttachments: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    });
    expect(fixture.release).not.toHaveBeenCalled();
    expect(fixture.preparations[operation.key]).toBe(0);
  },
);
