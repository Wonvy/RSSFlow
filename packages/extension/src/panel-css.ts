export const PANEL_CSS = `
:host{all:initial}
*{box-sizing:border-box}
.layer,.hover{position:fixed;inset:0;pointer-events:none}
.hover{display:none;inset:auto;left:0;top:0;border:2px solid #e8590c;background:rgba(232,89,12,.12);border-radius:4px;transition:transform .05s,width .05s,height .05s}
.layer .item{position:fixed;left:0;top:0;border:2px solid rgba(232,89,12,.85);background:rgba(232,89,12,.08);border-radius:4px}
.panel{
  --bg:#ffffff;--surface:#f6f6f4;--text:#1d1d1f;--muted:#6b6b70;--border:#e4e4e0;--accent:#e8590c;--accent-text:#fff;--warn-bg:#fff4e6;--warn:#a6460a;--danger:#c92a2a;
  position:fixed;top:16px;right:16px;width:min(372px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;
  pointer-events:auto;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:14px;
  box-shadow:0 12px 40px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.08);
  font:14px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-align:left;
}
.panel.left{right:auto;left:16px}
@media (prefers-color-scheme:dark){.panel{--bg:#1e1e20;--surface:#28282b;--text:#ececed;--muted:#a0a0a6;--border:#36363a;--accent:#ff8a3d;--accent-text:#141415;--warn-bg:#3a2416;--warn:#ffb27a;--danger:#ff6b6b}}
header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 10px 14px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg);z-index:1;cursor:grab;touch-action:none;user-select:none}
.panel.dragging{user-select:none;box-shadow:0 18px 50px rgba(0,0,0,.28),0 2px 6px rgba(0,0,0,.1)}
.panel.dragging header{cursor:grabbing}
.grip{color:var(--muted);font-size:12px;letter-spacing:-2px;margin-right:2px}
.brand{display:flex;align-items:center;gap:6px;font-weight:700}
.brand svg{width:18px;height:18px;color:var(--accent)}
.head-actions{display:flex;gap:4px}
.body{padding:14px}
button,input,select{font:inherit;color:inherit}
.icon{border:0;background:transparent;width:28px;height:28px;border-radius:6px;cursor:pointer;color:var(--muted)}
.icon:hover{background:var(--surface);color:var(--text)}
.icon.on{background:var(--accent);color:var(--accent-text)}
.paused{display:flex;gap:10px;align-items:center;padding:10px 14px;background:var(--warn-bg);color:var(--warn);font-size:13px;border-bottom:1px solid var(--border)}
.paused span{flex:1}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);cursor:pointer;text-decoration:none;color:var(--text);font-size:13px;white-space:nowrap}
.btn:hover:not(:disabled){background:var(--surface)}
.btn:disabled{opacity:.45;cursor:default}
.btn.sm{padding:4px 8px;font-size:12px}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text);font-weight:600}
.btn.primary:hover:not(:disabled){filter:brightness(1.05);background:var(--accent)}
.btn.block{width:100%;padding:11px;font-size:15px;margin-top:14px}
.link{border:0;background:none;color:var(--accent);cursor:pointer;padding:0 0 0 8px;font-size:12px}
.step{display:flex;gap:12px;align-items:flex-start}
.num{flex:none;width:28px;height:28px;border-radius:50%;background:var(--accent);color:var(--accent-text);display:grid;place-items:center;font-weight:700}
.big{font-size:16px;font-weight:600;margin:2px 0 4px}
.muted{color:var(--muted);font-size:12.5px;margin:0}
.note{margin-top:14px;padding:10px;border-radius:10px;background:var(--surface)}
.note p{margin:0 0 6px;font-size:13px}
.found{display:flex;align-items:center;justify-content:space-between;gap:8px}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0 10px;align-items:center}
.chip{font-size:12px;padding:1px 8px;border-radius:999px;background:var(--surface);border:1px solid var(--border)}
.chip.yes{color:var(--accent);border-color:var(--accent)}
.chip.no{color:var(--muted)}
.src{font-size:12px;color:var(--muted);margin-left:4px}
.tip{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:10px;background:var(--surface);font-size:12.5px;margin:0 0 10px}
.check.api{margin:0 0 10px;padding:8px 10px;border-radius:10px;border:1px solid var(--accent);background:var(--surface)}
.detail{margin-top:12px;padding:10px;border-radius:10px;background:var(--surface)}
.detail .check{margin-top:0}
.detail .check.sub{margin:8px 0 0 22px}
.detail .check.sub + .status{margin-left:44px}
.detail .status{margin:4px 0 0 22px;font-size:12px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.ok{color:var(--accent)}
.tune{margin-top:14px}
.tune .seg{margin-top:10px}
.found strong{font-size:16px}
.seg{display:flex;gap:6px;flex-wrap:wrap}
h4{margin:14px 0 6px;font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.fields{border:1px solid var(--border);border-radius:10px;overflow:hidden}
.field{display:grid;grid-template-columns:minmax(44px,max-content) 1fr auto;gap:8px;align-items:center;padding:7px 10px;border-top:1px solid var(--border);font-size:13px}
.field:first-child{border-top:0}
.fname{color:var(--muted);font-size:12px}
.fval{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.fval.muted{font-style:italic}
.fbtns{white-space:nowrap}
.preview{list-style:none;margin:0;padding:0;border:1px solid var(--border);border-radius:10px;max-height:240px;overflow:auto}
.preview li{display:flex;gap:10px;padding:8px 10px;border-top:1px solid var(--border)}
.preview li:first-child{border-top:0}
.preview img{width:52px;height:40px;object-fit:cover;border-radius:5px;flex:none;background:var(--surface)}
.pv{min-width:0}
.pt{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.pd{color:var(--muted);font-size:11.5px}
.ps{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lbl{display:flex;flex-direction:column;gap:4px;margin-top:12px;font-size:12.5px;color:var(--muted)}
.lbl input,.lbl select{padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:14px;width:100%}
.mono{font-family:ui-monospace,Menlo,monospace!important;font-size:12px!important}
.check{display:flex;gap:8px;align-items:flex-start;margin-top:10px;font-size:13px;cursor:pointer}
.check input{margin-top:3px;accent-color:var(--accent)}
details{margin-top:12px;border-top:1px solid var(--border);padding-top:8px}
summary{cursor:pointer;color:var(--muted);font-size:13px}
.error{color:var(--danger);font-size:13px;margin:12px 0 0}
.api{margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--surface);border:1px solid var(--accent)}
.api .check{margin-top:0}
.api .muted{margin:4px 0 0 22px}
.apiurl{margin:6px 0 0 22px;font:11.5px ui-monospace,Menlo,monospace;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hint{margin-top:10px}
.tag{display:inline-block;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;font:11px ui-monospace,Menlo,monospace;color:var(--muted);background:var(--surface);border-radius:4px;padding:1px 6px}
.warn{background:var(--warn-bg);color:var(--warn);padding:8px 10px;border-radius:8px;font-size:13px}
.done-head{font-size:17px;font-weight:700;margin-bottom:10px;color:var(--accent)}
.copyline{display:flex;gap:6px;margin:6px 0}
.copyline input{flex:1;min-width:0;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font:12px ui-monospace,Menlo,monospace;color:var(--text)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;background:#1d1d1f;color:#fff;padding:8px 14px;border-radius:999px;font:13px system-ui,sans-serif;transition:all .2s}
.toast.show{opacity:1;transform:translateX(-50%)}
`;
