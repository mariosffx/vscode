# Fork TO-DO

Remaining work on this fork of microsoft/vscode: a JetBrains-style tool window layout, built in phases. Phase 1 is merged on branch `secondary-activity-bar`. Items under Phase 1 come from a review of that branch where every listed finding was confirmed by two independent reviewers reading the code.

Last updated: 2026-10-15.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Vertical Secondary Activity Bar beside the Secondary Side Bar, independent position setting | Done, follow-ups below |
| 1.1 | Fixes and tests from the Phase 1 review | Not started |
| 2 | Four-corner tool windows: lower Primary and lower Secondary Side Bar, top and bottom icon groups per rail | Planned, open questions first |
| Tooling | mise tasks for upstream sync, build, release, install | Done, Windows tasks unverified |

## Phase 1.1: Secondary Activity Bar follow-ups

### High priority

- [ ] **Migrate existing users' settings.** Before this branch, `workbench.activityBar.location` also controlled the Secondary Side Bar. Users who set it to `top`, `bottom` or `hidden` now silently get the new vertical rail. Add a configuration migration in `src/vs/workbench/browser/workbench.contribution.ts`, next to the existing one for that setting, that copies an explicit `top`, `bottom` or `hidden` into `workbench.secondarySideBar.activityBarLocation` when that is unset. Decide whether an explicit `default` should map to `title`, the old look. Extend the legacy `workbench.activityBar.visible: false` migration the same way.

### Behavior

- [ ] **Clicking the active rail icon should collapse the Secondary Side Bar**, like the primary rail does. `src/vs/workbench/browser/parts/paneCompositeBar.ts` around line 814 only special-cases `Parts.ACTIVITYBAR_PART`. Map each rail to its side bar and honour `workbench.activityBar.iconClickBehavior` for both.
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

## Phase 2: four-corner tool windows

Goal: drag any view container to left-top, left-bottom, right-top or right-bottom and keep up to four side panes open at once. Two new view container locations hold the lower corners, as parts stacked under the existing side bars in the same grid column with a sash, hidden when empty. Each vertical rail gets a top icon group and a bottom icon group. The Panel stays as is; its containers can already be dragged into side bars.

### Decide first

These answers change the implementation, so settle them before writing code.

1. **Persistence.** Store the new locations as new numbers in the synced `views.customizations` key, or keep the column number there and store the lower slot in a fork-only field? New numbers crash stock VS Code and older fork builds when Settings Sync carries them over. The fork-only field is the safer choice. If it is a separate key, does it sync or stay per machine?
2. **Context key.** New `viewContainerLocation` values break existing when-clauses such as `viewContainerLocation == sidebar` in core and in extensions. Reusing the column value plus a separate slot key avoids that.
3. **Naming.** "Lower", "Bottom", or JetBrains-style corner names for the enum, parts, commands and labels.
4. **Toggles.** Does Ctrl+B hide the whole left column or only the upper part? Is each corner toggled independently?
5. **Sizing.** Does the lower part fill the column when the upper one is hidden? Is the split ratio stored per workspace or per profile, and what is the default?
6. **Non-vertical rails.** Where do the lower group's icons go when a rail is at the top, bottom, title or hidden: a second title bar on the lower part, or merged into the upper title?
7. **Maximize, Zen mode, centered layout.** Should Maximize Secondary Side Bar include the lower part, and what do Zen mode and centered layout do with the lower parts?
8. **Visibility.** Should moving a container into a hidden lower part reveal it, and should a user-hidden lower part stay hidden while it still has content?
9. **Extensions.** Should extensions be able to contribute directly to the lower corners through new `viewsContainers` keys? Recommendation: no, keep the extension contract identical to upstream.
10. **Sessions window.** Support the lower locations in `src/vs/sessions`, or map them to the column so nothing throws there?
11. **Panel containers.** Offer them as targets for the lower corners in move menus and drag and drop?

### Implementation plan

Risk is noted per step. Steps 2, 4 and 5 carry most of it.

1. [ ] **Locations and helpers** *(medium)*. Append two values to `ViewContainerLocation` in `src/vs/workbench/common/views.ts` so stored numbers stay valid. Extend `ViewContainerLocationToString`, which has no default case. Add helpers mapping a lower location to its column, plus one list of all locations to replace the hard-coded lists in `paneCompositePartService.ts` and `paneCompositeBar.ts`.
2. [ ] **Safe persistence, before any UI** *(high)*. Implement the decision on question 1 in `src/vs/workbench/services/views/browser/viewDescriptorService.ts`. Sanitize every read so an unknown location falls back to the container's default, at construction, on storage change and for generated containers. Update save, reset and move telemetry. Test a round trip, an unknown value, and a storage change without the slot field.
3. [ ] **Two lower pane composite parts** *(medium)*. New `Parts` values, parts built by parameterizing `SidebarPart` and `AuxiliaryBarPart` with an options object as `ActivitybarPart` now is, their own storage keys, context keys, title menus and pane composite registries. Wire into `PaneCompositePartService`, `workbench.ts`, the sessions window's service and the test services.
4. [ ] **Stack them in the grid** *(high)*. In `layout.ts`, replace each side bar leaf with a vertical branch, add state keys for hidden, size and empty, and re-attach the lower view after every grid move: side bar position flip, panel position change, size restore. Extend visibility, focus, resize, saved sizes, startup restore, and hide-when-empty.
5. [ ] **Top and bottom icon groups on each rail** *(high)*. Add an optional lower group to `IActivitybarPartOptions`, render it anchored to the bottom of the rail with a separator, split the overflow height, show a drop zone for an empty group during drag, and fall back to a title composite bar when a rail is not vertical. Add the lower locations to the composite bar's move menu.
6. [ ] **Update every location switch** *(medium)*. Route through the column helper unless a site needs part-specific behavior. Sites include the views service, view pane and container, terminal group, chat view pane, chat actions, chat input, layout actions, view quick access, navigation, panel and auxiliary bar actions, and view menu actions.
7. [ ] **Drag and drop to all four corners** *(medium)*. One drop handler per rail group, plus a "dock to bottom" drop target over the lower portion of an upper side bar for both containers and single views. Reveal a hidden lower part on drop.
8. [ ] **Modern UI floating cards** *(medium)*. Treat the seam between stacked cards as inner edges, include lower parts in edge ownership, add CSS for the gap and sash, extend the layout service tests.
9. [ ] **Commands, context keys, menus** *(low)*. Toggle and focus commands per lower part, visibility and active-container context keys, View > Appearance entries, an optional default split ratio setting. Make maximize, Zen mode and centered layout consistent with the answers above.
10. [ ] **Extension point** *(low)*. Implement or explicitly skip new `viewsContainers` keys per question 9, and make sure contribution order counters ignore containers sitting in lower locations.
11. [ ] **Tests and manual checks** *(medium)*. Unit tests for persistence, two-group rails including drops into an empty group, the new parts' storage keys, and floating margins. The grid composition has no unit tests, so check by hand with the launch skill: side bar flip, panel position and alignment, maximize, Zen mode, and a restart that restores all four corners.

## Fork tooling

- [ ] **Run the Windows tasks on Windows.** `mise run release:windows` and `mise run install:windows` call `scripts/mise/release-windows.ps1` and `scripts/mise/install-windows.ps1`. PowerShell is not installed on the Linux machine, so neither script has been run or syntax-checked yet.
- [ ] **Try `mise run release:rpm`.** It needs `rpmbuild` (`sudo apt install rpm`), which is not installed, so it has not been run.
- [ ] **Watch two upstream build patches on every rebase.** Local release builds needed two changes outside the feature, and upstream may change the same code:
  - `build/lib/extensions.ts`, `copilotSdkStream`: local packaging re-adds the `@github/copilot` SDK files that the root `build/.moduleignore` strips. Without it, packaging fails with "Copilot SDK directory not found". Microsoft's CI never hits this because it ships Copilot as a prebuilt VSIX.
  - `build/linux/dependencies-generator.ts`, `VSCODE_LINUX_DEPS_FROM_REFERENCE`: uses the committed package dependency list because Ubuntu 26.04's `dpkg-shlibdeps` Perl modules crash on the Debian 11 sysroot. Only the mise release tasks set it.
- [ ] **Consider upstreaming the Copilot packaging fix.** It is a genuine bug in local, non-CI packaging, and a pull request to microsoft/vscode would remove a rebase hazard from the fork.
