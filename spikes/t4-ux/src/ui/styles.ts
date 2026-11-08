// Візуальна модель станів: кожен стан займає ту саму зарезервовану комірку
// фіксованої ширини й висоти — зміна стану не зсуває розмітку.
export const ROW_H = 36
export const VIEW_H = 600
export const css = `
*{box-sizing:border-box} body{margin:0;font:14px/1.3 system-ui,sans-serif;color:#1d232b;background:#f6f7f9}
.security{height:24px;color:#a52020;font-size:12px;max-width:1000px;margin:0 auto}
#app{max-width:1000px;margin:0 auto;padding:12px}
.toolbar{display:flex;align-items:center;gap:8px;height:40px}
.toolbar .slot{width:300px;flex:none;overflow:hidden;gap:6px;height:28px;display:flex;align-items:center}
.hidden{visibility:hidden}
button{font:inherit;font-size:12px;padding:2px 8px;height:24px;border:1px solid #c5ccd6;border-radius:4px;background:#fff;cursor:pointer}
.banner{background:#e8f1ff;border:1px solid #9cc0ff;border-radius:4px;padding:2px 8px;font-size:12px}
.list{position:relative;height:${VIEW_H}px;overflow:auto;background:#fff;border:1px solid #dde2e8;border-radius:6px}
.row{position:absolute;left:0;right:0;height:${ROW_H}px;display:grid;grid-template-columns:70px 1fr 100px 70px 280px;align-items:center;gap:8px;padding:0 8px;border-bottom:1px solid #eef1f4;box-shadow:inset 3px 0 0 transparent}
.row a{color:inherit}
.placeholder{color:#9aa4b1}
.state-col{display:grid;grid-template-columns:1fr 28px;align-items:center;gap:6px}
.state{display:flex;min-width:0;align-items:center;gap:6px;height:28px;font-size:12px;white-space:nowrap;overflow:hidden}
.st-pending .pf{font-style:italic;color:#5b6675}
.st-pending .state{color:#5b6675}
.st-unknown{box-shadow:inset 3px 0 0 #8fa3bf}
.st-unknown .state{color:#4b5d78}
.st-failed{box-shadow:inset 3px 0 0 #d43c3c;background:#fff6f6}
.st-failed .state{color:#a52020}
.st-conflict{box-shadow:inset 3px 0 0 #d99a00;background:#fffaf0}
.st-conflict .state{color:#8a6100}
.st-stale{box-shadow:inset 3px 0 0 #b8c0cc}
.st-stale .state{color:#6b7684}
.st-removed{background:#f3f4f6;color:#8a929c}
.st-removed .cells{text-decoration:line-through}
.st-removed .state{color:#6b7684}
.del .cells{text-decoration:line-through;opacity:.6}
.card{background:#fff;border:1px solid #dde2e8;border-radius:6px;padding:12px;box-shadow:inset 3px 0 0 transparent}
.card label{display:grid;grid-template-columns:120px 1fr;align-items:center;height:36px}
.card input{font:inherit;height:28px;padding:0 6px;border:1px solid #c5ccd6;border-radius:4px}
.note{height:60px;overflow:hidden;color:#3c4652;border:1px dashed #e1e5ea;padding:4px;border-radius:4px}
.lines{margin-top:12px;border-collapse:collapse;width:100%}
.lines td,.lines th{border-bottom:1px solid #eef1f4;height:30px;text-align:left;padding:0 6px}
`
