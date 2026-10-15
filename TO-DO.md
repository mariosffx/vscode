# Fork TO-DO

Remaining work on this fork of microsoft/vscode: a JetBrains-style tool window layout, built in phases. Phase 1 is merged on branch `secondary-activity-bar`. Items under Phase 1 come from a review of that branch where every listed finding was confirmed by two independent reviewers reading the code.

Last updated: 2026-10-15.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Vertical Secondary Activity Bar beside the Secondary Side Bar, independent position setting | Done, follow-ups below |
| 1.1 | Fixes and tests from the Phase 1 review | Not started |
| 2 | Split side bars: a resizable top and bottom half in each side bar, with top and bottom icon groups per rail | Done, follow-ups below |
| Tooling | mise tasks for upstream sync, build, release, install | Done, Windows tasks unverified |

## Phase 1.1: Secondary Activity Bar follow-ups

### High priority

- [ ] **Migrate existing users' settings.** Before this branch, `workbench.activityBar.location` also controlled the Secondary Side Bar. Users who set it to `top`, `bottom` or `hidden` now silently get the new vertical rail. Add a configuration migration in `src/vs/workbench/browser/workbench.contribution.ts`, next to the existing one for that setting, that copies an explicit `top`, `bottom` or `hidden` into `workbench.secondarySideBar.activityBarLocation` when that is unset. Decide whether an explicit `default` should map to `title`, the old look. Extend the legacy `workbench.activityBar.visible: false` migration the same way.

### Behavior

- [x] **Clicking the active rail icon should collapse the Secondary Side Bar**, like the primary rail does. Done with the split side bar work. `src/vs/workbench/browser/parts/paneCompositeBar.ts` around line 814 only special-cases `Parts.ACTIVITYBAR_PART`. Map each rail to its side bar and honour `workbench.activityBar.iconClickBehavior` for both.
- [ ] **Hide the rail when the Secondary Side Bar has no view containers.** Today an empty location still shows an empty rail. `AuxiliaryBarPart` already has a `VisibleViewContainersTracker` to drive this. Consider honouring `workbench.activityBar.autoHide` with one container too.
- [ ] **Restore sash snap-open for the Secondary Side Bar.** In the default rail position its own composite bar is gone, so the inherited `snap` getter in `paneCompositePart.ts` sees no containers. Override `snap` in `AuxiliaryBarPart` to use the delegating `getVisiblePaneCompositeIds()`.
- [ ] **Stop the new setting from forcing the custom title bar on.** Choosing `top` or `bottom` for the secondary position flips `window.customTitleBarVisibility` from `never`, which the side bar header does not need. Remove the new setting from `TITLE_BAR_SETTINGS` and the forcing condition in `src/vs/workbench/browser/layout.ts`, and from `isTitleBarEmpty()` in `layoutService.ts`.
- [ ] **Chat view padding follows the wrong setting.** `chatViewPane.ts` line 276 still reads `workbench.activityBar.location` when chat lives in the Secondary Side Bar. Read the secondary setting there and listen for its changes.
- [ ] **Reset Layout ignores the new setting.** Add `resetSetting(LayoutSettings.AUXILIARY_ACTIVITY_BAR_LOCATION)` next to the existing activity bar reset in `src/vs/workbench/browser/actions/layoutActions.ts` around line 1619.
- [ ] **Localization metadata of the position commands.** `SetAuxiliaryActivityBarPositionAction` in `activitybarPart.ts` passes the localized title as the `original` title. Build the titles with `localize2` like the primary position commands.

### Visual

- [ ] **Startup splash does not paint the rail.** The splash records only the primary rail, so it draws the Secondary Side Bar against the window edge and the editor one rail too wide, then everything shifts. Add the rail width and bounds in `src/vs/workbench/contrib/splash/browser/partsSplash.ts`, the layout info type in the theme service, and paint it in `src/vs/code/electron-browser/workbench/workbench.ts`.
- [ ] **Modern UI panel gap.** The floating-panels rule that adds a trailing gap where a horizontal panel meets a rail, `floatingPanels.css` line 101, is keyed on the primary side bar only. Mirror the code in `getFloatingPaneCompositeHorizontalMargins`, which already handles the secondary rail. The root element has no side bar position class yet, so add one or move the margin to code.

### Tests

Follow the existing snapshot style: one `assert.deepStrictEqual` per behavior.

- [ ] `layoutService.test.ts`, horizontal margins suite: the Secondary Side Bar meeting its own rail on both sides, a horizontal panel meeting the right-hand secondary rail across alignments, and the changed outer-edge logic for a justified panel with only the rail visible.
- [ ] `layoutService.test.ts`, edge owners suite: rail with a vertical panel, collapsed Secondary Side Bar with the primary side bar on the right, maximized Secondary Side Bar with the rail. *Only one of two reviewers upheld this gap.*
- [ ] New `auxiliaryBarPart.test.ts` suite: for each position value, snapshot whether the composite bar shows, its position, label mode, rail visibility, and the remembered position after hide and toggle.
- [ ] `activitybarPart.test.ts`: context menu ids and labels for both rails in default and title positions, no compact menu bar and no `activitybar-compact` root class from the secondary rail, standalone-gap width with the side bar on the right and in compact density.
- [ ] Focus order: `findVisibleNeighbour` in `navigationActions.ts` with the secondary rail visible and hidden.
- [ ] Custom title bar: `shouldShowCustomTitleBar` per secondary position value. *Only one of two reviewers upheld this gap; it becomes moot if the title bar item above is fixed.*

### Accessibility (contested)

- [ ] Both rails announce the same accessible name. Pass a distinct label such as "Secondary Side Bar View Switcher" through `IActivitybarPartOptions`. *Only one of two reviewers upheld this.*

## Phase 2: split side bars (lighter design)

Each side bar splits into a top and a bottom half that each show one view container, with a sash between them to resize. A right-click "Move to Bottom Half" on a rail icon, or a drag onto a rail's bottom icon group, puts a container in the bottom half. There are no new view container locations and no new workbench grid parts: the bottom half is a pane composite part nested inside its side bar, and a per-profile list decides which half a container lives in. This replaced the heavier four-location plan, which would have touched far more of the workbench.

### Done

- [x] Bottom half for the Primary and the Secondary Side Bar, with its own title, toolbar, empty state and a close button.
- [x] Resizable split: drag the sash, double-click it to reset to half and half. The ratio is remembered per profile.
- [x] Bottom icon group on each vertical rail, above Accounts and Manage. Clicking the active icon closes the bottom half. While dragging, an empty group shows a drop zone.
- [x] Move containers between halves by drag and drop or the "Move to Top Half" / "Move to Bottom Half" context menu actions, including drops from other locations and of single views.
- [x] Opening a bottom-half container from anywhere (commands, keyboard shortcuts, views service) opens it in the bottom half. The views service treats it as visible, so features like revealing a file in a bottom-half Explorer work.
- [x] Hiding a side bar closes its bottom half too, and showing it restores the bottom half. Reloading restores both halves, the split size and the icon groups.
- [x] With the rail at the top, at the bottom or in the title, the bottom half shows its icons in its own title.
- [x] Unit tests for the stored assignment and the split height math.
- [x] Fixes from an adversarial review: opening a bottom container while the side bar is hidden, keeping the top half filled on startup and reopen, moving between halves without opening the default container, reconciling assignment changes from other windows, progress bars, the view toggle shortcuts, Explorer compressed-folder keys, view drop position, and drag drop-zone sizing.

### Remaining

- [ ] **Keyboard navigation** between the rail's top and bottom icon groups with the arrow keys. Today the bottom group is reachable with Tab only.
- [ ] **Commands** to focus the bottom half and to move the focused view container to the other half, so the feature is usable without a mouse.
- [ ] **Title context menu** of each half could offer "Move to Top Half" / "Move to Bottom Half" too; today those actions live on the rail icons only.
- [ ] **Code that asks for the single active view container** still sees only the top half. The views service is covered; a few features call the pane composite service directly, for example chat, to check whether their container is showing. Find and update them as they come up.
- [ ] **Startup splash** paints neither half separately.
- [ ] **Move View pickers.** "View: Move View" and "View: Move Focused View" list only top-half containers, because the pane composite service's id lists come from the top group. Make those lists include bottom-half ids, without changing what "Next/Previous Side Bar View" cycles through.
- [ ] **Secondary Side Bar empty check.** When every Secondary Side Bar container sits in the bottom half, layout.ts records the bar as empty, so new windows start with it hidden. Count both halves there.
- [ ] **Accessibility help in the bottom half.** Several Alt+F1 help providers key off `sideBarFocus` plus the top half's active container, so focus in the bottom half shows help for the top half's container. Use `sideBarBottomFocus` and `activeViewletBottom` in those when-clauses.
- [ ] **Integration test** with the launch skill that scripts the manual checks: move, drag, resize, close, reload.

## Fork tooling

- [ ] **Run the Windows tasks on Windows.** `mise run release:windows` and `mise run install:windows` call `scripts/mise/release-windows.ps1` and `scripts/mise/install-windows.ps1`. PowerShell is not installed on the Linux machine, so neither script has been run or syntax-checked yet.
- [ ] **Try `mise run release:rpm`.** It needs `rpmbuild` (`sudo apt install rpm`), which is not installed, so it has not been run.
- [ ] **Watch two upstream build patches on every rebase.** Local release builds needed two changes outside the feature, and upstream may change the same code:
  - `build/lib/extensions.ts`, `copilotSdkStream`: local packaging re-adds the `@github/copilot` SDK files that the root `build/.moduleignore` strips. Without it, packaging fails with "Copilot SDK directory not found". Microsoft's CI never hits this because it ships Copilot as a prebuilt VSIX.
  - `build/linux/dependencies-generator.ts`, `VSCODE_LINUX_DEPS_FROM_REFERENCE`: uses the committed package dependency list because Ubuntu 26.04's `dpkg-shlibdeps` Perl modules crash on the Debian 11 sysroot. Only the mise release tasks set it.
- [ ] **Consider upstreaming the Copilot packaging fix.** It is a genuine bug in local, non-CI packaging, and a pull request to microsoft/vscode would remove a rebase hazard from the fork.
