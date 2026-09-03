(() => {
  const statuses = ["Planned", "Released", "In Progress", "Installed", "Blocked"];
  const colors = { Planned:{color:"#8b98a3",opacity:35}, Released:{color:"#2670b8",opacity:70}, "In Progress":{color:"#d99028",opacity:85}, Installed:{color:"#26835b",opacity:100}, Blocked:{color:"#b4413f",opacity:90} };
  const state = { assemblies: [], workspace: null, selectedId: "", allObjectIds: [] };
  const $ = id => document.getElementById(id);
  const els = { status:$("connectionStatus"), diagnostics:$("diagnostics"), refresh:$("refreshButton"), import:$("importInput"), export:$("exportButton"), template:$("templateButton"), exact:$("showExactButton"), upto:$("showUpToButton"), color:$("colorButton"), sequenceFilter:$("sequenceFilter"), search:$("searchInput"), rows:$("assemblyRows"), total:$("totalCount"), sequenced:$("sequencedCount"), progress:$("progressCount"), installed:$("installedCount"), hint:$("selectedHint"), selectedId:$("selectedId"), selectedSequence:$("selectedSequence"), selectedStatus:$("selectedStatus"), apply:$("applyButton") };

  const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
  const norm = value => String(value ?? "").trim();
  const header = value => norm(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  const escapeHtml = value => norm(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const setStatus = (message, detail) => { els.status.textContent = message; if (detail) els.diagnostics.textContent = detail; };
  const sort = () => state.assemblies.sort((a,b) => (Number(a.sequence)||Infinity)-(Number(b.sequence)||Infinity) || a.uniqueId.localeCompare(b.uniqueId,undefined,{numeric:true}));

  function clearTransientData() {
    state.assemblies.length = 0;
    state.allObjectIds.length = 0;
    state.workspace = null;
    state.selectedId = "";
  }
  const setInteractive = enabled => document.querySelectorAll("button,input,select").forEach(control => { control.disabled = !enabled; });
  function validateHostingOrigin() {
    const configured = norm(document.querySelector('meta[name="sequence-tracker-company-origin"]')?.content).replace(/\/$/, "");
    let expected;
    try { expected = new URL(configured); } catch { expected = null; }
    if (!expected || expected.protocol !== "https:" || expected.origin !== configured) {
      setInteractive(false);
      setStatus("Extension blocked — approved host is not configured", "Set sequence-tracker-company-origin to the dedicated company-controlled HTTPS origin before deployment.");
      return false;
    }
    if (window.location.origin !== expected.origin) {
      setInteractive(false);
      setStatus("Extension blocked — unapproved host", `Expected ${expected.origin}; received ${window.location.origin}.`);
      return false;
    }
    setInteractive(true);
    return true;
  }

  function valueOf(object, names) {
    const wanted = new Set(names.map(header)); const props = [];
    const visit = value => { if (!value || typeof value !== "object") return; if (Array.isArray(value)) return value.forEach(visit); if (value.name || value.key || value.propertyName) props.push(value); Object.values(value).forEach(child => { if (child && typeof child === "object") visit(child); }); };
    visit(object);
    const prop = props.find(item => [item.name,item.key,item.propertyName,item.label,item.displayName].some(name => wanted.has(header(name))));
    return norm(prop?.value ?? prop?.formattedValue ?? prop?.text ?? prop?.stringValue ?? prop?.valueString);
  }
  const uniqueIdOf = item => valueOf(item,["Unique ID","UniqueID","UniqueId","UDA_UID","UDA UID","Assembly Unique ID","Assembly UDA_UID","GUID","GlobalId"]);
  const assemblyMarkOf = item => valueOf(item,["Assembly/Cast unit Mark","Assembly/Cast Unit Mark","Assembly Position","Assembly Mark","Cast Unit Mark"]);
  const typeOf = item => valueOf(item,["Object Type","Type","Ifc Type","Entity","Category","Tekla Type"]);
  const runtimeIds = item => { const ids=[]; const visit=x=>{if(!x||typeof x!=="object")return; const id=Number(x.runtimeId ?? x.id);if(Number.isFinite(id))ids.push(id);(x.children||[]).forEach(visit)}; visit(item); return [...new Set(ids)]; };
  const flattenRuntimeIds = objects => (objects || []).flatMap(item => typeof item === "number" ? [item] : Array.isArray(item) ? flattenRuntimeIds(item) : [item?.runtimeId,item?.id,...flattenRuntimeIds(item?.children)].filter(Boolean)).map(Number).filter(Number.isFinite);
  const groups = raw => !Array.isArray(raw) ? [] : raw.some(item => item?.modelId && Array.isArray(item?.objects)) ? raw : [{modelId:"",modelName:"Model",objects:raw}];

  function toAssembly(modelId, modelName, item) {
    const uniqueId = uniqueIdOf(item); const mark = assemblyMarkOf(item); const type = typeOf(item);
    if (!uniqueId || (!mark && !/assembly|cast.?unit/i.test(type))) return null;
    const existing = state.assemblies.find(row => row.uniqueId === uniqueId);
    return { modelId, modelName, uniqueId, assemblyMark: mark || existing?.assemblyMark || "", runtimeIds:runtimeIds(item), sequence:existing?.sequence || "", status:existing?.status || "Planned", updatedAt:existing?.updatedAt || stamp() };
  }

  function mergeAssembly(found, row) {
    const existing = found.get(row.uniqueId);
    if (!existing) return found.set(row.uniqueId, row);
    existing.runtimeIds = [...new Set([...existing.runtimeIds, ...row.runtimeIds])];
    existing.assemblyMark ||= row.assemblyMark;
  }
  async function collectAssemblies(rawGroups, modelNames, found) {
    for (const group of groups(rawGroups)) {
      const modelId=group.modelId||group.model?.id||group.id; if(!modelId) continue;
      const modelName=group.modelName||group.name||group.model?.name||modelNames.get(modelId)||"Model";
      const objects=Array.isArray(group.objects)?group.objects:[];
      const ids=[...new Set(flattenRuntimeIds(objects))];
      state.allObjectIds.push({modelId,objectRuntimeIds:ids});
      for (const item of objects) { const row=toAssembly(modelId,modelName,item); if(row)mergeAssembly(found,row); }
      for (let start=0; start<ids.length; start+=500) {
        const properties=await state.workspace.viewer.getObjectProperties(modelId,ids.slice(start,start+500)).catch(()=>[]);
        for (const item of properties || []) { const row=toAssembly(modelId,modelName,item); if(row)mergeAssembly(found,row); }
      }
    }
  }
  async function refresh() {
    if (!state.workspace?.viewer) return setStatus("Standalone mode — import an Excel schedule to begin.");
    els.refresh.disabled = true; setStatus("Reading assemblies from Trimble Connect…");
    try {
      const models = await state.workspace.viewer.getModels(); const names = new Map((models||[]).map(m=>[m.id||m.modelId,m.name||m.fileName||"Model"]));
      const found=new Map(); state.allObjectIds=[];
      await collectAssemblies(await state.workspace.viewer.getObjects().catch(()=>[]),names,found);
      if (!found.size) await collectAssemblies(await state.workspace.viewer.getObjects({selected:true}).catch(()=>[]),names,found);
      if (!found.size) { setStatus("No assemblies found", "Full-model refresh completed, but no objects exposed both Unique ID and an assembly mark/type."); return; }
      state.assemblies=[...found.values()]; sort(); render(); setStatus(`Loaded ${state.assemblies.length} assemblies`, "Full-model refresh completed. Import Excel to fill the Seq column and update status.");
    } catch (error) { setStatus("Could not read model assemblies", error.message || String(error)); } finally { els.refresh.disabled=false; }
  }

  function render() {
    const query=header(els.search.value); const visible=state.assemblies.filter(row=>!query || header(row.uniqueId).includes(query)||header(row.assemblyMark).includes(query));
    els.total.textContent=state.assemblies.length; els.sequenced.textContent=state.assemblies.filter(r=>Number(r.sequence)>0).length; els.progress.textContent=state.assemblies.filter(r=>r.status==="In Progress").length; els.installed.textContent=state.assemblies.filter(r=>r.status==="Installed").length;
    els.rows.innerHTML=visible.length ? visible.map(row=>`<tr data-id="${escapeHtml(row.uniqueId)}" class="${row.uniqueId===state.selectedId?"selected":""}"><td>${escapeHtml(row.sequence)}</td><td>${escapeHtml(row.uniqueId)}</td><td>${escapeHtml(row.assemblyMark)}</td><td><span class="status ${header(row.status).replace("inprogress","in-progress")}">${escapeHtml(row.status)}</span></td><td>${escapeHtml(row.modelName)}</td><td>${escapeHtml(row.updatedAt)}</td></tr>`).join("") : `<tr><td colspan="6" class="empty">No assemblies loaded. Refresh the viewer, then import an Excel schedule.</td></tr>`;
    els.rows.querySelectorAll("tr[data-id]").forEach(row=>row.addEventListener("click",()=>select(row.dataset.id)));
  }
  async function select(id) { state.selectedId=id; const row=state.assemblies.find(item=>item.uniqueId===id); if(!row)return; els.selectedId.value=row.uniqueId;els.selectedSequence.value=row.sequence;els.selectedStatus.value=row.status;els.hint.textContent=`${row.assemblyMark||"Assembly"} — ${row.modelName}`;render(); const target=[{modelId:row.modelId,objectRuntimeIds:row.runtimeIds}]; try { await state.workspace?.viewer?.setSelection({modelObjectIds:target},"set"); await state.workspace?.viewer?.setCamera({modelObjectIds:target},{animationTime:300}); } catch {} }
  function apply() { const row=state.assemblies.find(item=>item.uniqueId===state.selectedId);if(!row)return;row.sequence=Number(els.selectedSequence.value)||"";row.status=els.selectedStatus.value;row.updatedAt=stamp();sort();render();setStatus("Updated in this session", "Export Excel before closing the app to keep these changes. Nothing is written to the Trimble model."); }

  function readColumn(row,names){const values=Object.fromEntries(Object.keys(row).map(key=>[header(key),row[key]]));return names.map(name=>norm(values[header(name)])).find(Boolean)||""}
  function parseCsv(text) {
    const [headers, ...lines] = text.split(/\r?\n/).filter(Boolean).map(line => line.split(",").map(cell => cell.trim().replace(/^"|"$/g, "")));
    return headers ? lines.map(cells => Object.fromEntries(headers.map((name, index) => [name, cells[index] || ""]))) : [];
  }
  async function importExcel(file) { if(!file)return; try {
    let rows=[];
    if (/\.csv$/i.test(file.name)) rows=parseCsv(await file.text());
    else if (window.XLSX) { const book=XLSX.read(await file.arrayBuffer(),{type:"array"}); rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{defval:""}); }
    if(!rows.length)throw new Error("No readable rows. Use .xlsx, .xls, or CSV with Unique ID.");
    let matched=0; for(const item of rows){const id=readColumn(item,["Unique ID","UniqueID","Unique Id","UDA_UID"]);const row=state.assemblies.find(value=>value.uniqueId===id);if(!row)continue;row.sequence=Number(readColumn(item,["Sequence Number","Sequence","Seq","Seq No","Proposed Sequence Number"]))||"";const status=readColumn(item,["Installation Status","Status"]);row.status=statuses.includes(status)?status:row.status;row.updatedAt=stamp();matched++;}sort();render();setStatus(`Imported ${matched} matching schedule rows`, `${rows.length-matched} Excel rows did not match a loaded assembly Unique ID.`);
  } catch(error){setStatus("Excel import failed",error.message||String(error));} finally {els.import.value=""} }
  function download(rows,name){if(window.XLSX){const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),"Assemblies");XLSX.writeFile(book,name);return;}const csv=[Object.keys(rows[0]||{}).join(","),...rows.map(r=>Object.values(r).map(v=>`"${String(v).replace(/"/g,'""')}"`).join(","))].join("\n");const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));link.download=name;link.click();}
  function exportExcel(){download(state.assemblies.map(row=>({"Unique ID":row.uniqueId,"Assembly Position":row.assemblyMark,"Sequence Number":row.sequence,"Installation Status":row.status,"Model Name":row.modelName,"Updated At":row.updatedAt})),"assembly-sequence-tracker.xlsx");}
  function template(){download([{"Unique ID":"Example-UID-001","Sequence Number":1,"Installation Status":"Planned"}],"assembly-sequence-template.xlsx");}
  const selectedForSequence=mode=>state.assemblies.filter(row=>Number(row.sequence)>0&&(mode==="exact"?Number(row.sequence)===Number(els.sequenceFilter.value):Number(row.sequence)<=Number(els.sequenceFilter.value)));
  async function show(mode){const number=Number(els.sequenceFilter.value);if(!number)return setStatus("Enter a sequence number first");const rows=selectedForSequence(mode), groupsByModel=new Map();rows.forEach(row=>{if(!groupsByModel.has(row.modelId))groupsByModel.set(row.modelId,new Set());row.runtimeIds.forEach(id=>groupsByModel.get(row.modelId).add(id));});const targets=[...groupsByModel].map(([modelId,ids])=>({modelId,objectRuntimeIds:[...ids]}));try{await state.workspace?.viewer?.setObjectState(undefined,{visible:false});await state.workspace?.viewer?.setObjectState({modelObjectIds:targets},{visible:true});await state.workspace?.viewer?.setCamera({modelObjectIds:targets},{animationTime:300});setStatus(`Showing ${rows.length} assemblies`,`Sequence ${mode} ${number}`);}catch{setStatus(`Found ${rows.length} assemblies`,"Viewer visibility is available only inside Trimble Connect.");}}
  async function color(){try{for(const status of statuses){const rows=state.assemblies.filter(row=>row.status===status);const map=new Map();rows.forEach(row=>{if(!map.has(row.modelId))map.set(row.modelId,new Set());row.runtimeIds.forEach(id=>map.get(row.modelId).add(id));});const targets=[...map].map(([modelId,ids])=>({modelId,objectRuntimeIds:[...ids]}));if(targets.length)await state.workspace?.viewer?.setObjectState({modelObjectIds:targets},colors[status]);}setStatus("Applied status colors");}catch{setStatus("Status colours are ready when opened inside Trimble Connect.");}}
  async function connect(){render();if(!validateHostingOrigin())return;const bridge=window.TrimbleConnectWorkspace;if(!bridge?.connect)return setStatus("Standalone mode — import Excel or open this as a Trimble extension.");try{state.workspace=await bridge.connect(window.parent,undefined,30000);setStatus("Connected to Trimble Connect");await refresh();}catch{setStatus("Standalone mode — connection unavailable.");}}
  window.addEventListener("pagehide", clearTransientData);
  els.refresh.addEventListener("click",refresh);els.import.addEventListener("change",e=>importExcel(e.target.files[0]));els.export.addEventListener("click",exportExcel);els.template.addEventListener("click",template);els.apply.addEventListener("click",apply);els.search.addEventListener("input",render);els.exact.addEventListener("click",()=>show("exact"));els.upto.addEventListener("click",()=>show("upTo"));els.color.addEventListener("click",color);connect();
})();
