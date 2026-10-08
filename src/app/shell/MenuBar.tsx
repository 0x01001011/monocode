import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ExplorerMenu,
  type ExplorerMenuItem,
} from "../../features/files/ui/ExplorerMenu";
import { ALT, MOD, SHIFT } from "../../platform/tauri/platform";
import { nextRovingIndex } from "../../features/workspace/ui/rovingFocus";
import { runUpdateFlow } from "../model/updater";
import {
  keybindingShortcutLabel,
  loadAutosave,
  loadKeybindingOverrides,
  saveAutosave,
  subscribeAutosave,
  subscribeKeybindings,
} from "../../features/settings/model/settings";

type MenuKey = "file" | "view" | "terminal";

type Props = {
  onNew: () => void;
  onNewTerminal?: () => void;
  onToggleTerminal?: () => void;
  onGoToFile?: () => void;
  onToggleSidebar: () => void;
  onToggleSessionSidebar: () => void;
  onShowSourceControl?: () => void;
  onCloseCurrentTab?: () => void;
  onCloseOtherTabs?: () => void;
  onCloseAllTabs?: () => void;
  onPickProject?: () => void;
  onFindInProject?: () => void;
  onSearch?: () => void;
  onOpenInbox?: () => void;
  onOpenNotes?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
};

export function MenuBar({
  onNew,
  onNewTerminal,
  onToggleTerminal,
  onGoToFile,
  onToggleSidebar,
  onToggleSessionSidebar,
  onShowSourceControl,
  onCloseCurrentTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onPickProject,
  onFindInProject,
  onSearch,
  onOpenInbox,
  onOpenNotes,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: Props) {
  const [open, setOpen] = useState(false);
  const [activeMenu, setActiveMenu] = useState<MenuKey | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [, refreshShortcuts] = useState(loadKeybindingOverrides);
  const [autosave, setAutosave] = useState(loadAutosave);
  const barRef = useRef<HTMLDivElement>(null);
  const [tabStop, setTabStop] = useState<MenuKey>("file");
  // Where focus was when Alt revealed the bar, so closing it can hand focus back.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const menuButtons = () =>
    Array.from(
      barRef.current?.querySelectorAll<HTMLElement>("[data-menubar-item]") ??
        [],
    );

  useEffect(
    () =>
      subscribeKeybindings(() => refreshShortcuts(loadKeybindingOverrides())),
    [],
  );

  useEffect(
    () => subscribeAutosave(() => setAutosave(loadAutosave())),
    [],
  );

  const shortcut = (command: string, keys: string) =>
    keybindingShortcutLabel(command, keys) ?? undefined;

  // Toggle with standalone Alt key tap
  useEffect(() => {
    let altPressedAlone = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        altPressedAlone = true;
      } else if (altPressedAlone) {
        altPressedAlone = false;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt" && altPressedAlone) {
        setOpen((prev) => {
          if (prev) {
            setActiveMenu(null);
            setMenuAnchor(null);
            return false;
          }
          return true;
        });
        altPressedAlone = false;
      }
    };

    const onBlur = () => {
      altPressedAlone = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const openDropdown = useCallback((key: MenuKey, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setActiveMenu(key);
    setMenuAnchor({ x: rect.left, y: rect.bottom + 2 });
  }, []);

  const closeMenu = useCallback(() => {
    setActiveMenu(null);
    setMenuAnchor(null);
  }, []);

  // Alt reveals the bar and moves focus into it; hiding it hands focus back.
  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      if (!barRef.current?.contains(active)) {
        restoreFocusRef.current = active instanceof HTMLElement ? active : null;
      }
      menuButtons()[0]?.focus();
      return;
    }
    restoreFocusRef.current?.focus();
    restoreFocusRef.current = null;
  }, [open]);

  const handlePick = useCallback(
    (id: string) => {
      closeMenu();
      // The command decides where focus goes next.
      restoreFocusRef.current = null;
      setOpen(false);

      switch (id) {
        case "new_tab":
          onNew();
          break;
        case "new_terminal":
          onNewTerminal?.();
          break;
        case "toggle_terminal":
          onToggleTerminal?.();
          break;
        case "new_window":
          void invoke("open_new_window").catch(() => {});
          break;
        case "open_project":
          onPickProject?.();
          break;
        case "open_search":
          onSearch?.();
          break;
        case "open_inbox":
          onOpenInbox?.();
          break;
        case "open_notes":
          onOpenNotes?.();
          break;
        case "go_to_file":
          onGoToFile?.();
          break;
        case "find_in_project":
          onFindInProject?.();
          break;
        case "close_tab":
          onCloseCurrentTab?.();
          break;
        case "close_other_tabs":
          onCloseOtherTabs?.();
          break;
        case "close_all_tabs":
          onCloseAllTabs?.();
          break;
        case "toggle_autosave": {
          const next = saveAutosave(!loadAutosave());
          setAutosave(next);
          break;
        }
        case "toggle_sidebar":
          onToggleSidebar();
          break;
        case "toggle_session_sidebar":
          onToggleSessionSidebar();
          break;
        case "open_model_picker":
          window.dispatchEvent(new Event("open_model_picker"));
          break;
        case "toggle_diff":
          onShowSourceControl?.();
          break;
        case "check_for_updates":
          void runUpdateFlow(true);
          break;
        case "zoom_in":
          onZoomIn?.();
          break;
        case "zoom_out":
          onZoomOut?.();
          break;
        case "zoom_reset":
          onZoomReset?.();
          break;
      }
    },
    [
      closeMenu,
      autosave,
      onCloseCurrentTab,
      onCloseOtherTabs,
      onCloseAllTabs,
      onFindInProject,
      onGoToFile,
      onNew,
      onNewTerminal,
      onToggleTerminal,
      onPickProject,
      onSearch,
      onOpenInbox,
      onOpenNotes,
      onShowSourceControl,
      onToggleSidebar,
      onToggleSessionSidebar,
      onZoomIn,
      onZoomOut,
      onZoomReset,
    ],
  );

  const getMenuItems = (key: MenuKey): ExplorerMenuItem[] => {
    switch (key) {
      case "file":
        return [
          {
            kind: "item",
            id: "new_tab",
            label: "New Tab",
            shortcut: shortcut("Tab: New", `${MOD}T`),
          },
          {
            kind: "item",
            id: "new_terminal",
            label: "New Terminal",
            shortcut: shortcut("Terminal: New", `${MOD}\``),
          },
          {
            kind: "item",
            id: "new_window",
            label: "New Window",
            shortcut: shortcut("App: New Window", `${MOD}${SHIFT}N`),
          },
          { kind: "sep" },
          {
            kind: "item",
            id: "toggle_autosave",
            label: "Autosave",
            checked: autosave,
          },
          { kind: "sep" },
          {
            kind: "item",
            id: "open_project",
            label: "Open Project…",
            shortcut: shortcut("App: Open Project", `${MOD}O`),
          },
          {
            kind: "item",
            id: "open_search",
            label: "Search…",
            shortcut: shortcut("App: Search", `${MOD}K`),
          },
          {
            kind: "item",
            id: "go_to_file",
            label: "Go to File…",
            shortcut: shortcut("App: Go to File", `${MOD}P`),
          },
          {
            kind: "item",
            id: "find_in_project",
            label: "Find in Files…",
            shortcut: shortcut("App: Find in Files", `${MOD}${SHIFT}F`),
          },
          { kind: "sep" },
          {
            kind: "item",
            id: "close_tab",
            label: "Close Pane",
            shortcut: shortcut("Pane: Close", `${MOD}W`),
          },
          {
            kind: "item",
            id: "close_other_tabs",
            label: "Close Other Tabs",
            shortcut: shortcut("Tab: Close Others", `${MOD}${ALT}T`),
          },
          {
            kind: "item",
            id: "close_all_tabs",
            label: "Close All Tabs",
            shortcut: shortcut("Tab: Close All", `${MOD}${SHIFT}W`),
          },
          { kind: "sep" },
          {
            kind: "item",
            id: "check_for_updates",
            label: "Check for Updates…",
          },
        ];
      case "view":
        return [
          {
            kind: "item",
            id: "toggle_sidebar",
            label: "Toggle Sidebar",
            shortcut: shortcut("App: Toggle Sidebar", `${MOD}B`),
          },
          {
            kind: "item",
            id: "toggle_session_sidebar",
            label: "Toggle Session Sidebar",
            shortcut: shortcut(
              "App: Toggle Session Sidebar",
              `${MOD}${SHIFT}B`,
            ),
          },
          { kind: "item", id: "open_inbox", label: "Inbox" },
          ...(onOpenNotes
            ? [{ kind: "item" as const, id: "open_notes", label: "Notes" }]
            : []),
          {
            kind: "item",
            id: "toggle_terminal",
            label: "Toggle Terminal",
            shortcut: shortcut("Terminal: Toggle Dock", `${MOD}J`),
          },
          {
            kind: "item",
            id: "open_model_picker",
            label: "Switch Model…",
            shortcut: shortcut("App: Switch Model", `${MOD}.`),
          },
          { kind: "item", id: "toggle_diff", label: "Toggle Changes" },
          { kind: "sep" },
          {
            kind: "item",
            id: "zoom_in",
            label: "Zoom In",
            shortcut: shortcut("View: Zoom In", `${MOD}+`),
          },
          {
            kind: "item",
            id: "zoom_out",
            label: "Zoom Out",
            shortcut: shortcut("View: Zoom Out", `${MOD}-`),
          },
          {
            kind: "item",
            id: "zoom_reset",
            label: "Reset Zoom",
            shortcut: shortcut("View: Reset Zoom", `${MOD}0`),
          },
        ];
      case "terminal":
        return [
          {
            kind: "item",
            id: "new_terminal",
            label: "New Terminal",
            shortcut: shortcut("Terminal: New", `${MOD}\``),
          },
          {
            kind: "item",
            id: "toggle_terminal",
            label: "Toggle Terminal",
            shortcut: shortcut("Terminal: Toggle Dock", `${MOD}J`),
          },
        ];
    }
  };

  if (!open && !activeMenu) {
    return null;
  }

  const MENUS: { key: MenuKey; label: string }[] = [
    { key: "file", label: "File" },
    { key: "view", label: "View" },
    { key: "terminal", label: "Terminal" },
  ];

  // The dropdown unmounts with focus inside it; put focus back on its button.
  const dismissMenu = () => {
    const key = activeMenu;
    closeMenu();
    if (!key) return;
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) {
        return;
      }
      barRef.current
        ?.querySelector<HTMLElement>(`[data-menubar-item="${key}"]`)
        ?.focus();
    });
  };

  const onBarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // Keys from the portaled dropdown bubble through React; leave them to it.
    if (!barRef.current?.contains(target)) return;
    const buttons = menuButtons();
    const index = buttons.indexOf(target);
    if (index < 0) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openDropdown(MENUS[index]!.key, target);
      return;
    }
    const next = nextRovingIndex(event.key, index, buttons.length);
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
    if (activeMenu) openDropdown(MENUS[next]!.key, buttons[next]!);
  };

  return (
    <div
      ref={barRef}
      role="menubar"
      aria-label="Application menu"
      onKeyDown={onBarKeyDown}
      className="flex h-7 shrink-0 items-center gap-0.5 border-b border-stroke bg-content/5 px-2 text-[12px]"
      data-tauri-drag-region="false"
    >
      {MENUS.map(({ key, label }) => {
        const isActive = activeMenu === key;
        return (
          <button
            key={key}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={isActive}
            data-menubar-item={key}
            tabIndex={tabStop === key ? 0 : -1}
            onFocus={() => setTabStop(key)}
            data-tauri-drag-region="false"
            onClick={(e) => {
              if (isActive) {
                closeMenu();
              } else {
                openDropdown(key, e.currentTarget);
              }
            }}
            onMouseEnter={(e) => {
              if (activeMenu && activeMenu !== key) {
                openDropdown(key, e.currentTarget);
              }
            }}
            className={`rounded px-2 py-0.5 transition-colors ${
              isActive
                ? "bg-selection-hover text-content"
                : "text-content/70 hover:bg-content/10 hover:text-content"
            }`}
          >
            {label}
          </button>
        );
      })}

      {activeMenu && menuAnchor ? (
        <ExplorerMenu
          x={menuAnchor.x}
          y={menuAnchor.y}
          items={getMenuItems(activeMenu)}
          ariaLabel={`${activeMenu} menu`}
          onPick={handlePick}
          onClose={dismissMenu}
        />
      ) : null}
    </div>
  );
}
