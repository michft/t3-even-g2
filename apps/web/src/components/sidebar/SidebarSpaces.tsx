import { ChevronUpIcon, LayoutGridIcon, PlusIcon } from "lucide-react";
import { type TouchEvent, type WheelEvent, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadSelectionStore } from "~/threadSelectionStore";
import {
  SIDEBAR_SPACE_COLORS,
  type SidebarSpace,
  createSidebarSpaceSwipe,
  sidebarProjectRefKey,
  sidebarSpaceIncludesGroup,
  sidebarSpaceScopeChanged,
  sidebarSpaceTouchSwipeDirection,
} from "@t3tools/client-runtime/state/sidebar-spaces";
import {
  type SidebarSpacesStore,
  useActiveSidebarSpace,
  useSidebarSpacesStore,
} from "~/sidebarSpacesStore";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A sidebar project group that can be ticked into a space. */
interface SpaceProjectOption {
  readonly projectKey: string;
  readonly displayName: string;
  readonly memberProjectRefs: readonly { environmentId: string; projectId: string }[];
}

/** Radio value for the All page; space IDs are UUIDs, so it cannot collide. */
const ALL_SPACES_VALUE = "all";

/** Every space change goes through here so selection is cleared whenever the visible scope moves. */
function changeSpaces(change: (store: SidebarSpacesStore) => void) {
  const before = useSidebarSpacesStore.getState();
  change(before);
  if (sidebarSpaceScopeChanged(before, useSidebarSpacesStore.getState())) {
    useThreadSelectionStore.getState().clearSelection();
  }
}

/** Horizontal trackpad or touch swipes on the thread list page between spaces. */
export function useSidebarSpaceSwipeHandlers() {
  const wheelRef = useRef<ReturnType<typeof createSidebarSpaceSwipe> | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  return {
    onWheel: (event: WheelEvent) => {
      if (wheelRef.current === null) wheelRef.current = createSidebarSpaceSwipe();
      const direction = wheelRef.current(event.deltaX, event.deltaY, event.timeStamp);
      if (direction !== 0) changeSpaces((store) => store.step(direction));
    },
    onTouchStart: (event: TouchEvent) => {
      const touch = event.touches[0];
      touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    },
    onTouchEnd: (event: TouchEvent) => {
      const start = touchStartRef.current;
      const touch = event.changedTouches[0];
      touchStartRef.current = null;
      if (!start || !touch) return;
      const direction = sidebarSpaceTouchSwipeDirection(
        touch.clientX - start.x,
        touch.clientY - start.y,
      );
      if (direction !== 0) changeSpaces((store) => store.step(direction));
    },
  };
}

/** Footer control that shows the current space and switches, creates, edits, or deletes spaces. */
export function SidebarSpaceSwitcher({
  projects,
}: {
  readonly projects: readonly SpaceProjectOption[];
}) {
  const spaces = useSidebarSpacesStore((state) => state.spaces);
  const setActiveSpace = (id: string | null) => changeSpaces((store) => store.setActiveSpace(id));
  const activeSpace = useActiveSidebarSpace();
  const [editing, setEditing] = useState<SidebarSpace | "new" | null>(null);

  return (
    <div className="flex min-w-0 items-center justify-end gap-1">
      <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
        <SpacePageButton
          label="All projects"
          active={activeSpace === null}
          onClick={() => setActiveSpace(null)}
        >
          <LayoutGridIcon className="size-3.5" />
        </SpacePageButton>
        {spaces.map((space) => (
          <SpacePageButton
            key={space.id}
            label={space.name}
            active={activeSpace?.id === space.id}
            onClick={() => setActiveSpace(space.id)}
          >
            <span className="size-2.5 rounded-full" style={{ backgroundColor: space.color }} />
          </SpacePageButton>
        ))}
      </div>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Space options"
              className="inline-flex h-7 min-w-0 max-w-28 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs font-medium text-sidebar-foreground hover:bg-sidebar-row-hover"
            />
          }
        >
          {activeSpace ? (
            <span
              className="size-2 shrink-0 rounded-sm"
              style={{ backgroundColor: activeSpace.color }}
            />
          ) : null}
          <span className="truncate">{activeSpace?.name ?? "All"}</span>
          <ChevronUpIcon className="size-3 shrink-0 text-muted-foreground" />
        </MenuTrigger>
        <MenuPopup side="top" align="end">
          {/* The footer dots can overflow; the menu always reaches every space. */}
          <MenuRadioGroup
            value={activeSpace?.id ?? ALL_SPACES_VALUE}
            onValueChange={(value) =>
              setActiveSpace(value === ALL_SPACES_VALUE ? null : String(value))
            }
          >
            <MenuRadioItem value={ALL_SPACES_VALUE} closeOnClick>
              <LayoutGridIcon />
              All projects
            </MenuRadioItem>
            {spaces.map((space) => (
              <MenuRadioItem key={space.id} value={space.id} closeOnClick>
                <span className="size-2.5 rounded-full" style={{ backgroundColor: space.color }} />
                <span className="min-w-0 truncate">{space.name}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          {activeSpace ? (
            <>
              <MenuItem onClick={() => setEditing(activeSpace)}>
                Edit “{activeSpace.name}”…
              </MenuItem>
              <MenuItem
                variant="destructive"
                onClick={() => changeSpaces((store) => store.deleteSpace(activeSpace.id))}
              >
                Delete space
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <MenuItem onClick={() => setEditing("new")}>
            <PlusIcon />
            New space…
          </MenuItem>
        </MenuPopup>
      </Menu>
      <SidebarSpaceDialog
        key={editing === null ? "closed" : editing === "new" ? "new" : editing.id}
        space={editing}
        projects={projects}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

/** One footer page button: the All grid or a space's color dot. */
function SpacePageButton(props: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            aria-pressed={props.active}
            onClick={props.onClick}
            className={cn(
              "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-row-hover",
              props.active && "bg-sidebar-row-hover text-sidebar-foreground ring-1 ring-ring/60",
            )}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Creates a space, or edits one, with its name, color, and projects. */
function SidebarSpaceDialog(props: {
  readonly space: SidebarSpace | "new" | null;
  readonly projects: readonly SpaceProjectOption[];
  readonly onClose: () => void;
}) {
  const spaceCount = useSidebarSpacesStore((state) => state.spaces.length);
  const existing = props.space !== null && props.space !== "new" ? props.space : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState<string>(
    existing?.color ?? SIDEBAR_SPACE_COLORS[spaceCount % SIDEBAR_SPACE_COLORS.length]!,
  );
  const [projectRefs, setProjectRefs] = useState(() => new Set(existing?.projectRefs ?? []));
  const canSave = name.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    const input = { name: name.trim(), color, projectRefs: [...projectRefs] };
    changeSpaces((store) => {
      if (existing) store.updateSpace(existing.id, input);
      else store.createSpace(input);
    });
    props.onClose();
  };

  return (
    <Dialog
      open={props.space !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit space" : "New space"}</DialogTitle>
          <DialogDescription>
            A space shows only its projects' threads. Swipe sideways on the thread list to move
            between spaces. Spaces are saved on this device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="sidebar-space-name">Name</Label>
              <Input
                id="sidebar-space-name"
                placeholder="Work"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Color</Label>
              <div className="flex gap-2">
                {SIDEBAR_SPACE_COLORS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-label={`Color ${option}`}
                    aria-pressed={color === option}
                    onClick={() => setColor(option)}
                    className={cn(
                      "size-6 cursor-pointer rounded-full",
                      color === option && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                    )}
                    style={{ backgroundColor: option }}
                  />
                ))}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Projects</Label>
              <div className="grid max-h-56 gap-2 overflow-y-auto">
                {props.projects.length === 0 ? (
                  <span className="text-sm text-muted-foreground">No projects yet.</span>
                ) : null}
                {props.projects.map((project) => (
                  <label
                    key={project.projectKey}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={sidebarSpaceIncludesGroup(
                        { projectRefs: [...projectRefs] },
                        project,
                      )}
                      onCheckedChange={(checked) =>
                        setProjectRefs((current) => {
                          const next = new Set(current);
                          for (const ref of project.memberProjectRefs) {
                            const key = sidebarProjectRefKey(ref);
                            if (checked) next.add(key);
                            else next.delete(key);
                          }
                          return next;
                        })
                      }
                    />
                    <span className="truncate">{project.displayName}</span>
                  </label>
                ))}
              </div>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {existing ? "Save" : "Create space"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
