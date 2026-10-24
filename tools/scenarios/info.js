// GPU / renderer info and a screenshot of the title screen.
const { renderer, view } = window.__game;
const gl = renderer.getContext();
const ext = gl.getExtension('WEBGL_debug_renderer_info');
await drive.frames(30);
await drive.shot('title');
return {
  gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  webgl2: renderer.capabilities.isWebGL2,
  dpr: window.devicePixelRatio, viewDpr: view.dpr, size: [innerWidth, innerHeight],
  bootMs: args.bootMs,
};
