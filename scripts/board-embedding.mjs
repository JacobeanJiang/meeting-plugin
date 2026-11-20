/** Open Artifact allows network-page ancestors but Chromium's '*' excludes file://.
 * Desktop Electron plugin pages can have a local file ancestor. Add just that scheme;
 * retain every other CSP directive and the engine's random owner URLs/Host checks.
 * Fail closed if an upstream update changes this header, so the patch is reviewed again.
 */
/** @param {string} bundle */
export function allowLocalBoardEmbedding(bundle) {
  const original="frame-ancestors *; object-src 'none'";
  const patched="frame-ancestors * file:; object-src 'none'";
  if(bundle.split(original).length!==2)throw Error('Open Artifact embedding header changed; review the local-frame compatibility patch');
  return bundle.replace(original,patched);
}

/** @param {string} html */
export function signalBoardReady(html) {
  if(html.split('</body>').length!==2)throw Error('Open Artifact editor HTML changed; review the readiness signal');
  // Only send a content-free readiness signal after the editor canvas actually mounted.
  const signal=`<script>(()=>{let observer;const notify=()=>{if(!document.querySelector('[data-testid="board-canvas"]'))return;observer?.disconnect();parent.postMessage({type:"xj-meeting-board-ready",version:1},"*");};observer=new MutationObserver(notify);observer.observe(document.body,{childList:true,subtree:true});notify();setTimeout(()=>observer.disconnect(),30000);})();</script>`;
  return html.replace('</body>',signal+'</body>');
}
