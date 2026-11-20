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
  return html.replace('</body>',signal+fitBoard+'</body>');
}
/**
 * The editor keeps its own camera, so a board drawn for another screen size can end up cut off at the side. It fits the board
 * with Mod+0; this triggers the same shortcut when the embedding page asks ({type:"xj-meeting-board-fit"} from the parent window)
 * and when the frame's width changes a lot. No content is read or sent.
 */
const fitBoard=`<script>(()=>{const fit=()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"0",code:"Digit0",metaKey:true,ctrlKey:true,bubbles:true,cancelable:true}));addEventListener("message",event=>{if(event.source===parent&&event.data&&event.data.type==="xj-meeting-board-fit")fit();});let width=innerWidth,timer=0;addEventListener("resize",()=>{clearTimeout(timer);timer=setTimeout(()=>{if(Math.abs(innerWidth-width)>width*.15){width=innerWidth;fit();}},400);});})();</script>`;
