(() => {
  const statuses = ["Planned", "Released", "In Progress", "Installed", "Blocked"];
  const colors = { Planned:{color:"#64748b",opacity:85}, Released:{color:"#2563eb",opacity:100}, "In Progress":{color:"#f59e0b",opacity:100}, Installed:{color:"#16a34a",opacity:100}, Blocked:{color:"#dc2626",opacity:100} };
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
  async function applyStatusColor(row) {
    if (!state.workspace?.viewer) return false;
    if (!row.runtimeIds.length) throw new Error("This assembly has no viewer object IDs.");
    const target={modelObjectIds:[{modelId:row.modelId,objectRuntimeIds:row.runtimeIds,recursive:true}]};
    await state.workspace.viewer.setObjectState(target,colors[row.status]||colors.Planned);
    return true;
  }
  async function select(id) {
    state.selectedId=id; const row=state.assemblies.find(item=>item.uniqueId===id); if(!row)return;
    els.selectedId.value=row.uniqueId;els.selectedSequence.value=row.sequence;els.selectedStatus.value=row.status;els.hint.textContent=`${row.assemblyMark||"Assembly"} — ${row.modelName}`;render();
    if (!state.workspace?.viewer) return;
    const target=[{modelId:row.modelId,objectRuntimeIds:row.runtimeIds,recursive:true}];
    try {
      await state.workspace.viewer.setSelection({modelObjectIds:target},"set");
      await applyStatusColor(row);
      await state.workspace.viewer.setCamera({modelObjectIds:target},{animationTime:300});
      setStatus(`Selected ${row.assemblyMark||row.uniqueId}`,`${row.status} colour applied in the 3D viewer.`);
    } catch(error) { setStatus("Assembly selected",`Could not apply its status colour: ${error.message||String(error)}`); }
  }
  async function apply() {
    const row=state.assemblies.find(item=>item.uniqueId===state.selectedId);if(!row)return;
    row.sequence=Number(els.selectedSequence.value)||"";row.status=els.selectedStatus.value;row.updatedAt=stamp();sort();render();
    try {
      const colored=await applyStatusColor(row);
      setStatus("Updated in this session",colored?`${row.status} colour applied in the 3D viewer. Export Excel before closing to keep these changes.`:"Export Excel before closing the app to keep these changes. Nothing is written to the Trimble model.");
    } catch(error) { setStatus("Status updated",`Could not apply its viewer colour: ${error.message||String(error)}`); }
  }

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
  const targetsForRows=rows=>{const groupsByModel=new Map();rows.forEach(row=>{if(!groupsByModel.has(row.modelId))groupsByModel.set(row.modelId,new Set());row.runtimeIds.forEach(id=>groupsByModel.get(row.modelId).add(id));});return [...groupsByModel].map(([modelId,ids])=>({modelId,objectRuntimeIds:[...ids],recursive:true})).filter(target=>target.objectRuntimeIds.length);};
  async function setAllVisibility(visible){if(!state.workspace?.viewer)return false;await state.workspace.viewer.setObjectState(undefined,{visible});return true;}
  function setSequenceMode(mode){els.exact.classList.toggle("active",mode==="exact");els.upto.classList.toggle("active",mode==="upTo");}
  async function show(mode){
    const number=Number(els.sequenceFilter.value);if(!Number.isFinite(number)||number<1)return setStatus("Enter a sequence number first");
    setSequenceMode(mode);const rows=selectedForSequence(mode),targets=targetsForRows(rows);
    if(!state.workspace?.viewer)return setStatus(`Found ${rows.length} assemblies`,"Viewer visibility is available only inside Trimble Connect.");
    try{
      await setAllVisibility(false);
      if(targets.length){await state.workspace.viewer.setObjectState({modelObjectIds:targets},{visible:true});await state.workspace.viewer.setCamera({modelObjectIds:targets},{animationTime:300});}
      setStatus(`Showing ${rows.length} assemblies`,mode==="exact"?`Sequence ${number} only`:`Sequences up to ${number}`);
    }catch(error){setStatus(`Found ${rows.length} assemblies`,`Could not update viewer visibility: ${error.message||String(error)}`);}
  }
  async function showAll(){setSequenceMode("upTo");if(!state.workspace?.viewer)return;try{await setAllVisibility(true);setStatus("Showing all assemblies","Sequence filter cleared.");}catch(error){setStatus("Could not restore viewer visibility",error.message||String(error));}}
  let sequenceInputTimer;
  function sequenceInputChanged(){clearTimeout(sequenceInputTimer);const number=Number(els.sequenceFilter.value);sequenceInputTimer=setTimeout(()=>number>=1?show("upTo"):showAll(),180);}
  function showFromButton(mode){clearTimeout(sequenceInputTimer);show(mode);}
  async function color(){try{for(const status of statuses){const targets=targetsForRows(state.assemblies.filter(row=>row.status===status));if(targets.length)await state.workspace?.viewer?.setObjectState({modelObjectIds:targets},{...colors[status],visible:true});}setStatus("Applied status colours","All loaded assemblies are visible and coloured by status.");}catch(error){setStatus("Could not apply status colours",error.message||String(error));}}
  async function connect(){render();const bridge=window.TrimbleConnectWorkspace;if(!bridge?.connect)return setStatus("Standalone mode — import Excel or open this as a Trimble extension.");try{state.workspace=await bridge.connect(window.parent,undefined,30000);setStatus("Connected to Trimble Connect");await refresh();}catch{setStatus("Standalone mode — connection unavailable.");}}
  window.addEventListener("pagehide", clearTransientData);
  els.refresh.addEventListener("click",refresh);els.import.addEventListener("change",e=>importExcel(e.target.files[0]));els.export.addEventListener("click",exportExcel);els.template.addEventListener("click",template);els.apply.addEventListener("click",apply);els.search.addEventListener("input",render);els.sequenceFilter.addEventListener("input",sequenceInputChanged);els.exact.addEventListener("click",()=>showFromButton("exact"));els.upto.addEventListener("click",()=>showFromButton("upTo"));els.color.addEventListener("click",color);setSequenceMode("upTo");connect();
})();
