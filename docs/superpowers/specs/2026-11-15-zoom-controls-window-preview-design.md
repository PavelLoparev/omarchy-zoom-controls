# Zoom Controls window preview design

Date: 2026-11-15
Status: approved

## Intent

While a Zoom meeting is active, the Zoom Controls bar popup should show a small
live view of the actual Zoom Chromium window, matching the live previews in
Omarchy Alt-Tab (the snappy-style switcher).

## Why

The popup exposes meeting controls but not the meeting itself. A live window
preview lets the user confirm what Zoom is showing (shared content, video,
participants) without switching windows.

## Goals

- Show a live, letterboxed preview of the Zoom window at the top of the popup.
- Show it only while `meetingState.state === "meeting"`.
- Capture only while the popup is open.
- Hide the preview when no matching Zoom toplevel exists.
- Keep the popup usable if capture has not produced a frame yet.

## Non-goals

- No preview on the Zoom home, sign-in, or prejoin screens.
- No click-to-focus behavior on the preview.
- No backend or CDP changes.
- No configurable preview size in this change.

## Constraints

- Omarchy 4 / Quickshell 0.3.2 already provides `ScreencopyView` in
  `Quickshell.Wayland`; Omarchy Alt-Tab is the working reference.
- The default launcher and the user's Chromium wrapper both pass
  `--class=zoom-controls-chromium`, which the Hyprland window rule also matches.
- The popup content cap is `Style.space(620)`. The current meeting menu is
  386 px tall, so a 16:9 preview fits without scrolling in the common case.
- The offscreen QML test runner cannot load `Quickshell.Wayland`, so the
  preview component must stay out of `MenuContent.qml` and the existing tests.

## Approaches

1. **`ScreencopyView` on the Zoom toplevel (chosen).** Reuse the same capture
   path as Omarchy Alt-Tab: find the toplevel in `Hyprland.toplevels` and point
   `ScreencopyView.captureSource` at `toplevel.wayland`, with `live` tied to the
   popup being open. Live, no extra processes, and captures the real window.
2. **Periodic `grim` screenshots.** Stale between captures, adds process and
   file churn, and needs extra cleanup. Rejected.
3. **CDP `Page.captureScreenshot`.** Shows only the web page, not the browser
   window, and requires backend/base64 plumbing. Rejected.

## Decisions

- New `WindowPreview.qml` at the plugin root owns the frame and capture.
- The frame is a clipped, rounded 16:9 rectangle. The captured window is
  centered and letterboxed to preserve its aspect ratio, as Alt-Tab does.
- `ZoomPanel.qml` finds the Zoom toplevel by Hyprland class or Wayland app id
  `zoom-controls-chromium` and refreshes that reference when the toplevel list
  changes. The preview appears above the existing `MenuContent`.
- `live` is true only while `root.opened`; otherwise the capture is released.
- Until a frame exists, the frame shows a small Zoom glyph instead of an empty
  black rectangle.
- The popup height uses the combined column implicit height so the preview
  participates in the existing `fittedContentHeight` cap and Flickable.

## Verification

- Run `./check`.
- With a meeting active, open the popup through `omarchy-shell zoom-controls
  open`, grab a screenshot, confirm the Zoom window is visible in the popup,
  and close it. Confirm the preview is absent outside a meeting.

## Left to the builder

Exact preview corner radius, border treatment, and placeholder glyph, following
the existing popup styling tokens in `MenuContent.qml`.
