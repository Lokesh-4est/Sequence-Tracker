(() => {
  const statuses = ["Planned", "Released", "In Progress", "Installed", "Blocked"];
  const colors = { Planned:{color:"#64748b",opacity:85}, Released:{color:"#2563eb",opacity:100}, "In Progress":{color:"#f59e0b",opacity:100}, Installed:{color:"#16a34a",opacity:100}, Blocked:{color:"#dc2626",opacity:100} };
  const psetConfig = { libraryName:"4EST Sequence Tracker", definitionName:"Assembly Sequence" };
  const nonGeometryClasses = new Set(["IFCELEMENTASSEMBLY","IFCPROJECT","IFCSITE","IFCBUILDING","IFCBUILDINGSTOREY","IFCSPACE","IFCSYSTEM","IFCZONE","IFCGROUP"]);
  const state = { assemblies: [], workspace: null, project: null, accessToken: "", storage: null, storagePromise: null, selectedId: "", allObjectIds: [], renderableObjectIds: [], dirtyIds:new Set(), pendingWriteIds:new Set(), saveInFlight:false };
  const $ = id => document.getElementById(id);
  const els = { status:$("connectionStatus"), diagnostics:$("diagnostics"), refresh:$("refreshButton"), import:$("importInput"), importToTrimble:$("importToTrimbleButton"), export:$("exportButton"), template:$("templateButton"), exact:$("showExactButton"), upto:$("showUpToButton"), color:$("colorButton"), sequenceFilter:$("sequenceFilter"), search:$("searchInput"), rows:$("assemblyRows"), total:$("totalCount"), sequenced:$("sequencedCount"), progress:$("progressCount"), installed:$("installedCount"), hint:$("selectedHint"), selectedId:$("selectedId"), selectedSequence:$("selectedSequence"), selectedStatus:$("selectedStatus"), apply:$("applyButton") };

  const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
  const norm = value => String(value ?? "").trim();
  const header = value => norm(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  const escapeHtml = value => norm(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const setStatus = (message, detail) => { els.status.textContent = message; if (detail) els.diagnostics.textContent = detail; };
  const sort = () => state.assemblies.sort((a,b) => (Number(a.sequence)||Infinity)-(Number(b.sequence)||Infinity) || a.uniqueId.localeCompare(b.uniqueId,undefined,{numeric:true}));

  function clearTransientData() {
    state.assemblies.length = 0;
    state.allObjectIds.length = 0;
    state.renderableObjectIds.length = 0;
    state.workspace = null;
    state.project = null;
    state.accessToken = "";
    state.storage = null;
    state.storagePromise = null;
    state.dirtyIds.clear();
    state.pendingWriteIds.clear();
    state.saveInFlight = false;
    state.selectedId = "";
  }

  function clearProjectData() {
    state.assemblies.length = 0;
    state.allObjectIds.length = 0;
    state.renderableObjectIds.length = 0;
    state.project = null;
    state.accessToken = "";
    state.storage = null;
    state.storagePromise = null;
    state.dirtyIds.clear();
    state.pendingWriteIds.clear();
    state.saveInFlight = false;
    state.selectedId = "";
  }

  function valueOf(object, names) {
    const wanted = new Set(names.map(header)); const props = [];
    const visit = value => { if (!value || typeof value !== "object") return; if (Array.isArray(value)) return value.forEach(visit); if (value.name || value.key || value.propertyName) props.push(value); Object.values(value).forEach(child => { if (child && typeof child === "object") visit(child); }); };
    visit(object);
    const prop = props.find(item => [item.name,item.key,item.propertyName,item.label,item.displayName].some(name => wanted.has(header(name))));
    return norm(prop?.value ?? prop?.formattedValue ?? prop?.text ?? prop?.stringValue ?? prop?.valueString);
  }
  const uniqueIdOf = item => valueOf(item,["Unique ID","UniqueID","UniqueId","UDA_UID","UDA UID","Assembly Unique ID","Assembly UDA_UID"]);
  const objectGuidOf = item => norm(item?.globalId ?? item?.globalID ?? item?.guid ?? item?.ifcGuid) || valueOf(item,["GlobalId","Global ID","IFC GlobalId","IFC GUID","GUID"]);
  const assemblyMarkOf = item => valueOf(item,["Assembly/Cast unit Mark","Assembly/Cast Unit Mark","Assembly Position","Assembly Mark","Cast Unit Mark"]);
  const typeOf = item => valueOf(item,["Object Type","Type","Ifc Type","Entity","Category","Tekla Type"]);
  const runtimeIds = item => { const ids=[]; const visit=x=>{if(!x||typeof x!=="object")return; const id=Number(x.runtimeId ?? x.id);if(Number.isFinite(id))ids.push(id);(x.children||[]).forEach(visit)}; visit(item); return [...new Set(ids)]; };
  const flattenRuntimeIds = objects => (objects || []).flatMap(item => typeof item === "number" ? [item] : Array.isArray(item) ? flattenRuntimeIds(item) : [item?.runtimeId,item?.id,...flattenRuntimeIds(item?.children)].filter(Boolean)).map(Number).filter(Number.isFinite);
  const groups = raw => !Array.isArray(raw) ? [] : raw.some(item => item?.modelId && Array.isArray(item?.objects)) ? raw : [{modelId:"",modelName:"Model",objects:raw}];

  function toAssembly(modelId, modelName, item) {
    const uniqueId = uniqueIdOf(item); const mark = assemblyMarkOf(item); const type = typeOf(item); const objectGuid = objectGuidOf(item);
    if (!uniqueId || (!mark && !/assembly|cast.?unit/i.test(type))) return null;
    const existing = state.assemblies.find(row => norm(row.uniqueId).toLowerCase() === norm(uniqueId).toLowerCase());
    const sameObject=!objectGuid||!existing?.objectGuid||objectGuid===existing.objectGuid;
    return { modelId, modelName, uniqueId, objectGuid:objectGuid || existing?.objectGuid || "", ambiguousGuid:sameObject&&(existing?.ambiguousGuid||false), assemblyMark: mark || existing?.assemblyMark || "", runtimeIds:runtimeIds(item), sequence:existing?.sequence || "", status:existing?.status || "Planned", updatedAt:existing?.updatedAt || stamp(), psetLink:sameObject?(existing?.psetLink||""):"", psetVersion:sameObject?existing?.psetVersion:undefined, psetSchemaVersion:sameObject?existing?.psetSchemaVersion:undefined };
  }

  function mergeAssembly(found, row) {
    const key=norm(row.uniqueId).toLowerCase();const existing = found.get(key);
    if (!existing) return found.set(key, row);
    existing.runtimeIds = [...new Set([...existing.runtimeIds, ...row.runtimeIds])];
    existing.assemblyMark ||= row.assemblyMark;
    existing.objectGuid ||= row.objectGuid;
    if (existing.objectGuid && row.objectGuid && existing.objectGuid !== row.objectGuid) existing.ambiguousGuid = true;
  }

  const trimbleHost = hostname => hostname === "connect.trimble.com" || hostname.endsWith(".connect.trimble.com");
  function serviceBase(value, fallback) {
    const candidate=norm(value)||fallback;const url=new URL(candidate);
    if (url.protocol!=="https:"||!trimbleHost(url.hostname)) throw new Error("Trimble returned an unexpected service address.");
    url.search="";url.hash="";url.pathname=url.pathname.replace(/\/+$/,"");
    if(!/\/v\d+$/i.test(url.pathname))url.pathname+=`${url.pathname?"":""}/v1`;
    return url.toString().replace(/\/+$/,"");
  }
  function requestUrl(base,path) {
    const root=new URL(`${base.replace(/\/+$/,"")}/`);const url=/^https?:\/\//i.test(path)?new URL(path):new URL(String(path).replace(/^\/+/,""),root);
    if(url.origin!==root.origin||!trimbleHost(url.hostname))throw new Error("Blocked an unexpected Property Set service address.");
    return url;
  }
  async function apiRequest(base,path,{method="GET",body}={}) {
    if(!state.accessToken)throw new Error("Trimble access-token permission is required.");
    const headers={Accept:"application/json",Authorization:`Bearer ${state.accessToken}`};
    if(body!==undefined)headers["Content-Type"]="application/json";
    const response=await fetch(requestUrl(base,path),{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer"});
    if(response.status===204)return null;
    const text=await response.text();let data=null;
    if(text){try{data=JSON.parse(text);}catch{data={message:text.slice(0,300)};}}
    if(!response.ok){
      if(response.status===401){state.accessToken="";state.storage=null;state.storagePromise=null;}
      const error=new Error(data?.message||data?.code||`Trimble service returned HTTP ${response.status}.`);error.status=response.status;error.code=data?.code;throw error;
    }
    return data;
  }
  async function listAll(base,path) {
    const items=[];let next=path;let pageCount=0;
    while(next&&pageCount<100){const page=await apiRequest(base,next);items.push(...(page?.items||[]));next=page?.next||"";pageCount++;}
    if(next)throw new Error("Trimble returned too many Property Set pages.");
    return items;
  }
  async function resolveServiceUrls() {
    const fallbacks={
      useast1:{orgApi:"https://org-api.us-east-1.connect.trimble.com/v1",psetApi:"https://pset-api.us-east-1.connect.trimble.com/v1"},
      northamerica:{orgApi:"https://org-api.us-east-1.connect.trimble.com/v1",psetApi:"https://pset-api.us-east-1.connect.trimble.com/v1"},
      asia:{orgApi:"https://org-api.ap-southeast-1.connect.trimble.com/v1",psetApi:"https://pset-api.ap-southeast-1.connect.trimble.com/v1"},
      apsoutheast1:{orgApi:"https://org-api.ap-southeast-1.connect.trimble.com/v1",psetApi:"https://pset-api.ap-southeast-1.connect.trimble.com/v1"},
      australia:{orgApi:"https://org-api.ap-southeast-2.connect.trimble.com/v1",psetApi:"https://pset-api.ap-southeast-2.connect.trimble.com/v1"},
      apsoutheast2:{orgApi:"https://org-api.ap-southeast-2.connect.trimble.com/v1",psetApi:"https://pset-api.ap-southeast-2.connect.trimble.com/v1"},
      europe:{orgApi:"https://org-api.eu-west-1.connect.trimble.com/v1",psetApi:"https://pset-api.eu-west-1.connect.trimble.com/v1"},
      euwest1:{orgApi:"https://org-api.eu-west-1.connect.trimble.com/v1",psetApi:"https://pset-api.eu-west-1.connect.trimble.com/v1"},
      unitedkingdom:{orgApi:"https://org-api.eu-west-2.connect.trimble.com/v1",psetApi:"https://pset-api.eu-west-2.connect.trimble.com/v1"},
      euwest2:{orgApi:"https://org-api.eu-west-2.connect.trimble.com/v1",psetApi:"https://pset-api.eu-west-2.connect.trimble.com/v1"}
    };
    const location=header(state.project?.location);let selected=null;
    try{
      const response=await apiRequest("https://app.connect.trimble.com/tc/api/2.0","regions");
      const servers=Array.isArray(response)?response:(response?.items||response?.servers||response?.data||[]);
      selected=servers.find(server=>[server?.location,server?.awsRegion,server?.serviceRegion,server?.region].some(value=>header(value)===location))||null;
    }catch(error){if(!fallbacks[location])throw new Error(`Could not resolve services for project region "${state.project?.location||"unknown"}": ${error.message||String(error)}`);}
    const fallback=fallbacks[location];
    if(!selected&&!fallback)throw new Error(`Project region "${state.project?.location||"unknown"}" is not supported by this tracker.`);
    return {orgApi:serviceBase(selected?.orgApi??selected?.["org-api"],fallback?.orgApi),psetApi:serviceBase(selected?.psetApi??selected?.["pset-api"],fallback?.psetApi)};
  }
  const safeDecode = value => {try{return decodeURIComponent(value);}catch{return value;}};
  function findPropertyKey(definition,names) {
    const props=definition?.schema?.props||{};const wanted=new Set(names.map(header));
    return Object.keys(props).find(key=>{
      const labels=[key,props[key]?.name,props[key]?.title];
      Object.entries(definition?.i18n||{}).forEach(([locale,translation])=>{if(locale!=="__prop-order__")labels.push(translation?.props?.[key]);});
      return labels.some(label=>wanted.has(header(label)));
    })||"";
  }
  function storageDefinition(library,definition,services) {
    const keys={
      uniqueId:findPropertyKey(definition,["Unique ID","UniqueID","Unique Id"]),
      sequence:findPropertyKey(definition,["Sequence Number","Sequence","Seq"]),
      status:findPropertyKey(definition,["Installation Status","Status"]),
      assemblyPosition:findPropertyKey(definition,["Assembly Position","Assembly Mark"])
    };
    const missing=Object.entries(keys).filter(([name,key])=>name!=="assemblyPosition"&&!key).map(([name])=>name);
    if(missing.length)throw new Error(`The "${psetConfig.definitionName}" definition is missing required fields: ${missing.join(", ")}.`);
    const schemaProps=definition.schema?.props||{};
    if(schemaProps[keys.uniqueId]?.type!=="string")throw new Error("Property Set field \"Unique ID\" must be Text.");
    if(!["integer","number"].includes(schemaProps[keys.sequence]?.type))throw new Error("Property Set field \"Sequence Number\" must be a whole Number.");
    const enumValues=schemaProps[keys.status]?.enum;
    if(schemaProps[keys.status]?.type!=="string"||!Array.isArray(enumValues))throw new Error("Property Set field \"Installation Status\" must be a Dropdown.");
    const statusValues=Object.fromEntries(statuses.map(status=>[status,enumValues.find(value=>header(value)===header(status))]));
    const missingStatuses=statuses.filter(status=>statusValues[status]===undefined);
    if(missingStatuses.length)throw new Error(`Installation Status dropdown is missing: ${missingStatuses.join(", ")}.`);
    return {...services,libraryId:library.id,definitionId:definition.id,schemaVersion:definition.v,keys,statusValues};
  }
  async function discoverStorage() {
    const services=await resolveServiceUrls();const projectId=state.project?.id;
    if(!projectId)throw new Error("The current Trimble project could not be identified.");
    const forest=encodeURIComponent(`project:${projectId}:data`);
    const node=await apiRequest(services.orgApi,`forests/${forest}/trees/ProjectContext/nodes/PSetLibs`);
    const libraryIds=(node?.links||[]).map(link=>safeDecode(norm(link))).filter(link=>link.startsWith("frn:lib:")).map(link=>link.slice(8));
    if(!libraryIds.length)throw new Error("No published Property Set libraries are attached to this project.");
    let library=null;
    for(const id of libraryIds){const candidate=await apiRequest(services.psetApi,`libs/${encodeURIComponent(id)}`).catch(()=>null);if(candidate&&header(candidate.name)===header(psetConfig.libraryName)){library=candidate;break;}}
    if(!library)throw new Error(`Published library "${psetConfig.libraryName}" is not attached to this project.`);
    const definitions=await listAll(services.psetApi,`libs/${encodeURIComponent(library.id)}/defs?top=500`);
    const definition=definitions.find(item=>header(item.name)===header(psetConfig.definitionName));
    if(!definition)throw new Error(`Definition "${psetConfig.definitionName}" was not found in "${psetConfig.libraryName}".`);
    return storageDefinition(library,definition,services);
  }
  const entityGuidFromLink = link => {const match=norm(link).match(/(?:^|\/)entity:([^/]+)$/);return match?safeDecode(match[1]):"";};
  const displayTimestamp = value => norm(value).replace("T"," ").replace(/\.\d+Z$/,"Z").slice(0,19);
  const statusFromStored = value => statuses.find(status=>header(state.storage?.statusValues?.[status])===header(value))||"";
  async function loadSavedSchedule({announce=true}={}) {
    if(!state.storage||!state.accessToken)return {loaded:0,snapshots:new Map()};
    const s=state.storage;const path=`libs/${encodeURIComponent(s.libraryId)}/defs/${encodeURIComponent(s.definitionId)}/psets?top=500`;
    const instances=await listAll(s.psetApi,path);const byGuid=new Map(state.assemblies.filter(row=>row.objectGuid).map(row=>[row.objectGuid,row]));const byUnique=new Map(state.assemblies.map(row=>[norm(row.uniqueId).toLowerCase(),row]));const snapshots=new Map();let loaded=0;
    for(const instance of instances){
      const props=instance?.props||{};const storedUnique=norm(props[s.keys.uniqueId]);const row=byGuid.get(entityGuidFromLink(instance.link))||byUnique.get(storedUnique.toLowerCase());
      if(!row)continue;
      row.psetLink=instance.link;row.psetVersion=instance.v;row.psetSchemaVersion=instance.schemaV;
      const sequence=Number(props[s.keys.sequence]);const status=statusFromStored(props[s.keys.status]);
      snapshots.set(norm(row.uniqueId).toLowerCase(),{sequence:Number.isInteger(sequence)&&sequence>0?sequence:"",status:status||row.status,link:instance.link});
      if(!state.dirtyIds.has(row.uniqueId)){
        row.sequence=Number.isInteger(sequence)&&sequence>0?sequence:"";
        if(status)row.status=status;
        row.updatedAt=displayTimestamp(instance.modifiedAt)||row.updatedAt;loaded++;
      }
    }
    sort();render();
    if(announce)setStatus(`Loaded ${loaded} saved schedule rows from Trimble`,`${psetConfig.libraryName} / ${psetConfig.definitionName}`);
    return {loaded,snapshots};
  }
  async function initializeTrimbleStorage({load=true}={}) {
    if(!state.accessToken||!state.project)return false;
    if(state.storage){if(load)await loadSavedSchedule();return true;}
    if(!state.storagePromise){
      state.storagePromise=(async()=>{setStatus("Connecting to Trimble Property Sets…",`Looking for ${psetConfig.libraryName} / ${psetConfig.definitionName}.`);state.storage=await discoverStorage();return true;})();
    }
    try{await state.storagePromise;if(load)await loadSavedSchedule();return true;}
    catch(error){state.storage=null;setStatus("Trimble Property Set setup is not ready",error.message||String(error));return false;}
    finally{state.storagePromise=null;render();}
  }
  function permissionToken(value) {
    const result=norm(value?.data??value);return !result||["pending","denied","unsupported"].includes(result.toLowerCase())?"":result;
  }
  async function ensureAccessToken() {
    if(state.accessToken)return state.accessToken;
    const result=await state.workspace?.extension?.requestPermission?.("accesstoken");const status=norm(result).toLowerCase();const token=permissionToken(result);
    if(token){state.accessToken=token;return token;}
    if(status==="denied")setStatus("Trimble storage permission was denied","Enable access-token permission in the extension settings, then try again.");
    else setStatus("Waiting for Trimble storage permission","Choose Allow in Trimble Connect. The temporary token stays in memory only.");
    render();return "";
  }
  async function enableTrimbleStorage() {
    try{if(await ensureAccessToken())await initializeTrimbleStorage({load:true});}
    catch(error){setStatus("Could not request Trimble storage permission",error.message||String(error));}
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
      const found=new Map(); state.allObjectIds=[];state.renderableObjectIds=[];
      await collectAssemblies(await state.workspace.viewer.getObjects().catch(()=>[]),names,found);
      if (!found.size) await collectAssemblies(await state.workspace.viewer.getObjects({selected:true}).catch(()=>[]),names,found);
      if (!found.size) { setStatus("No assemblies found", "Full-model refresh completed, but no objects exposed both Unique ID and an assembly mark/type."); return; }
      state.assemblies=[...found.values()]; sort(); render(); setStatus(`Loaded ${state.assemblies.length} assemblies`, "Full-model refresh completed. Import Excel to fill the Seq column and update status.");
      if(state.storage&&state.accessToken)await loadSavedSchedule().catch(error=>setStatus("Assemblies loaded, but saved schedule could not be read",error.message||String(error)));
    } catch (error) { setStatus("Could not read model assemblies", error.message || String(error)); } finally { els.refresh.disabled=false; }
  }

  function render() {
    const query=header(els.search.value); const visible=state.assemblies.filter(row=>!query || header(row.uniqueId).includes(query)||header(row.assemblyMark).includes(query));
    els.total.textContent=state.assemblies.length; els.sequenced.textContent=state.assemblies.filter(r=>Number(r.sequence)>0).length; els.progress.textContent=state.assemblies.filter(r=>r.status==="In Progress").length; els.installed.textContent=state.assemblies.filter(r=>r.status==="Installed").length;
    els.rows.innerHTML=visible.length ? visible.map(row=>`<tr data-id="${escapeHtml(row.uniqueId)}" class="${row.uniqueId===state.selectedId?"selected":""}"><td>${escapeHtml(row.sequence)}</td><td>${escapeHtml(row.uniqueId)}</td><td>${escapeHtml(row.assemblyMark)}</td><td><span class="status ${header(row.status).replace("inprogress","in-progress")}">${escapeHtml(row.status)}</span></td><td>${escapeHtml(row.modelName)}</td><td>${escapeHtml(row.updatedAt)}</td></tr>`).join("") : `<tr><td colspan="6" class="empty">No assemblies loaded. Refresh the viewer, then import an Excel schedule.</td></tr>`;
    els.rows.querySelectorAll("tr[data-id]").forEach(row=>row.addEventListener("click",()=>select(row.dataset.id)));
    const dirtyCount=state.dirtyIds.size;
    els.importToTrimble.disabled=!dirtyCount||state.saveInFlight;
    els.importToTrimble.textContent=dirtyCount?`Import to Trimble (${dirtyCount})`:"Import to Trimble";
    els.apply.disabled=!state.selectedId||state.saveInFlight;
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
    const sequence=Number(els.selectedSequence.value);
    if(!Number.isInteger(sequence)||sequence<1)return setStatus("Enter a whole sequence number","Sequence Number must be 1 or greater before saving to Trimble.");
    row.sequence=sequence;row.status=els.selectedStatus.value;row.updatedAt=stamp();state.dirtyIds.add(row.uniqueId);sort();render();
    try{await applyStatusColor(row);}catch(error){setStatus("Schedule value staged",`Viewer colour failed, but Trimble save will still be attempted: ${error.message||String(error)}`);}
    await saveRowsToTrimble([row]);
  }

  const psetLinkForRow = row => row.psetLink || (row.objectGuid ? `frn:entity:${row.objectGuid}` : "");
  function preparePSetChange(row) {
    const s=state.storage;const sequence=Number(row.sequence);const link=psetLinkForRow(row);
    if(row.ambiguousGuid)throw new Error(`${row.uniqueId}: the same Unique ID belongs to more than one IFC GUID.`);
    if(!link)throw new Error(`${row.uniqueId}: IFC GlobalId/GUID was not exposed by the loaded model.`);
    if(!Number.isInteger(sequence)||sequence<1)throw new Error(`${row.uniqueId}: Sequence Number must be a whole number of 1 or greater.`);
    if(!statuses.includes(row.status))throw new Error(`${row.uniqueId}: Installation Status is invalid.`);
    const props={[s.keys.uniqueId]:row.uniqueId,[s.keys.sequence]:sequence,[s.keys.status]:s.statusValues[row.status]};
    if(s.keys.assemblyPosition&&row.assemblyMark)props[s.keys.assemblyPosition]=row.assemblyMark;
    return {row,expected:{sequence,status:row.status},item:{link,libId:s.libraryId,defId:s.definitionId,schemaV:s.schemaVersion,v:Number.isInteger(row.psetVersion)?row.psetVersion:-1,props}};
  }
  async function saveRowsToTrimble(rows) {
    if(state.saveInFlight)return false;
    const uniqueRows=[...new Map((rows||[]).map(row=>[row.uniqueId,row])).values()];
    if(!uniqueRows.length)return setStatus("Nothing is staged for Trimble");
    try{
      if(!await ensureAccessToken()){uniqueRows.forEach(row=>state.pendingWriteIds.add(row.uniqueId));return false;}
      if(!await initializeTrimbleStorage({load:false}))return false;
      uniqueRows.forEach(row=>state.pendingWriteIds.delete(row.uniqueId));state.saveInFlight=true;render();setStatus(`Saving ${uniqueRows.length} schedule rows to Trimble…`,"The access token remains only in this page's JavaScript memory.");
      const plans=[];const validationErrors=[];
      uniqueRows.forEach(row=>{try{plans.push(preparePSetChange(row));}catch(error){validationErrors.push(error.message||String(error));}});
      if(!plans.length){setStatus("No rows could be saved",validationErrors[0]||"No valid schedule rows were found.");return false;}
      const returned=[];const serviceErrors=[];
      for(let start=0;start<plans.length;start+=500){
        const chunk=plans.slice(start,start+500);const response=await apiRequest(state.storage.psetApi,"psets/changeset",{method:"POST",body:{items:chunk.map(plan=>plan.item)}});
        returned.push(...(response?.items||[]));serviceErrors.push(...(response?.errors||[]));
        if(response?.status&&response.status!=="Done"&&response.itemCount===undefined)throw new Error(`Trimble accepted an asynchronous changeset (${response.status}); read-back is required before the result can be confirmed.`);
      }
      const failedLinks=new Set(serviceErrors.map(error=>error?.item?.link));
      const returnedByLink=new Map(returned.map(item=>[item.link,item]));
      const successfulPlans=plans.filter(plan=>!failedLinks.has(plan.item.link)&&(returnedByLink.has(plan.item.link)||returned.length===0));
      for(const plan of successfulPlans){
        const saved=returnedByLink.get(plan.item.link);if(saved){plan.row.psetLink=saved.link;plan.row.psetVersion=saved.v;plan.row.psetSchemaVersion=saved.schemaV;plan.row.updatedAt=displayTimestamp(saved.modifiedAt)||stamp();}
        state.dirtyIds.delete(plan.row.uniqueId);
      }
      let readBack={snapshots:new Map()};let readBackError="";
      try{readBack=await loadSavedSchedule({announce:false});}catch(error){readBackError=error.message||String(error);}
      const verified=successfulPlans.filter(plan=>{const actual=readBack.snapshots.get(norm(plan.row.uniqueId).toLowerCase());return actual&&Number(actual.sequence)===plan.expected.sequence&&actual.status===plan.expected.status;}).length;
      const remaining=validationErrors.length+serviceErrors.length+(successfulPlans.length-verified);
      const firstServiceError=serviceErrors[0]?.message||serviceErrors[0]?.code||"";
      if(readBackError)setStatus(`Saved ${successfulPlans.length} rows, but read-back failed`,readBackError);
      else if(remaining)setStatus(`Saved and verified ${verified} of ${uniqueRows.length} rows`,`${remaining} row(s) remain unresolved. ${validationErrors[0]||firstServiceError||"Trimble read-back did not match the submitted value."}`);
      else setStatus(`Saved and verified ${verified} schedule rows in Trimble`,`${psetConfig.libraryName} / ${psetConfig.definitionName}`);
      return remaining===0&&!readBackError;
    }catch(error){setStatus("Trimble save failed",error.message||String(error));return false;}
    finally{state.saveInFlight=false;render();}
  }
  const saveImportedRows = () => saveRowsToTrimble(state.assemblies.filter(row=>state.dirtyIds.has(row.uniqueId)));

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
    let matched=0; for(const item of rows){const id=readColumn(item,["Unique ID","UniqueID","Unique Id","UDA_UID"]);const row=state.assemblies.find(value=>norm(value.uniqueId).toLowerCase()===norm(id).toLowerCase());if(!row)continue;row.sequence=Number(readColumn(item,["Sequence Number","Sequence","Seq","Seq No","Proposed Sequence Number"]))||"";const status=readColumn(item,["Installation Status","Status"]);const normalizedStatus=statuses.find(value=>header(value)===header(status));row.status=normalizedStatus||row.status;row.updatedAt=stamp();state.dirtyIds.add(row.uniqueId);matched++;}sort();render();setStatus(`Staged ${matched} matching schedule rows`,`${rows.length-matched} Excel rows did not match a loaded assembly Unique ID. Review the table, then click Import to Trimble.`);
  } catch(error){setStatus("Excel import failed",error.message||String(error));} finally {els.import.value=""} }
  function download(rows,name){if(window.XLSX){const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),"Assemblies");XLSX.writeFile(book,name);return;}const csv=[Object.keys(rows[0]||{}).join(","),...rows.map(r=>Object.values(r).map(v=>`"${String(v).replace(/"/g,'""')}"`).join(","))].join("\n");const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));link.download=name;link.click();}
  function exportExcel(){download(state.assemblies.map(row=>({"Unique ID":row.uniqueId,"Assembly Position":row.assemblyMark,"Sequence Number":row.sequence,"Installation Status":row.status,"Model Name":row.modelName,"Updated At":row.updatedAt})),"assembly-sequence-tracker.xlsx");}
  function template(){download([{"Unique ID":"Example-UID-001","Sequence Number":1,"Installation Status":"Planned"}],"assembly-sequence-template.xlsx");}
  const selectedForSequence=mode=>state.assemblies.filter(row=>Number(row.sequence)>0&&(mode==="exact"?Number(row.sequence)===Number(els.sequenceFilter.value):Number(row.sequence)<=Number(els.sequenceFilter.value)));
  const targetsForRows=rows=>{const groupsByModel=new Map();rows.forEach(row=>{if(!groupsByModel.has(row.modelId))groupsByModel.set(row.modelId,new Set());row.runtimeIds.forEach(id=>groupsByModel.get(row.modelId).add(id));});return [...groupsByModel].map(([modelId,ids])=>({modelId,objectRuntimeIds:[...ids],recursive:true})).filter(target=>target.objectRuntimeIds.length);};
  async function objectPropertiesForIds(modelId,ids){
    const viewer=state.workspace?.viewer;if(!viewer)return [];
    const properties=[];
    for(let start=0;start<ids.length;start+=500)properties.push(...await viewer.getObjectProperties(modelId,ids.slice(start,start+500)));
    return properties;
  }
  const geometryIdsFromProperties=properties=>[...new Set((properties||[]).filter(item=>!nonGeometryClasses.has(String(item?.class||"").toUpperCase())).map(item=>Number(item?.runtimeId??item?.id)).filter(Number.isFinite))];
  async function geometryTargetsForAssemblies(targets){
    const viewer=state.workspace?.viewer;if(!viewer)return targets;
    const geometryTargets=[];
    for(const target of targets){
      const ids=new Set(target.objectRuntimeIds);
      if(typeof viewer.getHierarchyChildren==="function"){
        const children=await viewer.getHierarchyChildren(target.modelId,[...ids],4,true);
        (children||[]).forEach(child=>{const id=Number(child?.id);if(Number.isFinite(id))ids.add(id);});
      }
      const geometryIds=geometryIdsFromProperties(await objectPropertiesForIds(target.modelId,[...ids]));
      if(geometryIds.length)geometryTargets.push({modelId:target.modelId,objectRuntimeIds:geometryIds,recursive:false});
    }
    return geometryTargets;
  }
  async function allGeometryTargets(){
    if(state.renderableObjectIds.length)return state.renderableObjectIds;
    const targets=[];
    for(const group of state.allObjectIds){
      const geometryIds=geometryIdsFromProperties(await objectPropertiesForIds(group.modelId,group.objectRuntimeIds));
      if(geometryIds.length)targets.push({modelId:group.modelId,objectRuntimeIds:geometryIds,recursive:false});
    }
    state.renderableObjectIds=targets;
    return targets;
  }
  async function isolateTargets(targets){
    const viewer=state.workspace?.viewer;if(!viewer)return targets;
    const visibleTargets=await geometryTargetsForAssemblies(targets);
    if(!visibleTargets.length)throw new Error("The matching assemblies do not expose geometric child objects.");
    const allGeometry=await allGeometryTargets();
    const visibleByModel=new Map(visibleTargets.map(target=>[target.modelId,new Set(target.objectRuntimeIds)]));
    await viewer.setObjectState(undefined,{visible:"reset"});
    for(const group of allGeometry){
      const visibleIds=visibleByModel.get(group.modelId)||new Set();
      const hiddenIds=group.objectRuntimeIds.filter(id=>!visibleIds.has(id));
      if(hiddenIds.length)await viewer.setObjectState({modelObjectIds:[{modelId:group.modelId,objectRuntimeIds:hiddenIds,recursive:false}]},{visible:false});
    }
    await viewer.setObjectState({modelObjectIds:visibleTargets},{visible:true});
    const hiddenGroups=await viewer.getObjects(undefined,{visible:false});
    const hiddenByModel=new Map((hiddenGroups||[]).map(group=>[group.modelId,new Set(flattenRuntimeIds(group.objects||[]))]));
    const hiddenTargetCount=visibleTargets.reduce((count,target)=>count+target.objectRuntimeIds.filter(id=>hiddenByModel.get(target.modelId)?.has(id)).length,0);
    if(hiddenTargetCount)throw new Error(`Trimble Connect left ${hiddenTargetCount} target geometry objects hidden.`);
    return {visibleTargets,visibleCount:visibleTargets.reduce((count,target)=>count+target.objectRuntimeIds.length,0)};
  }
  async function setAllVisibility(visible){if(!state.workspace?.viewer)return false;await state.workspace.viewer.setObjectState(undefined,{visible:visible?"reset":false});return true;}
  function setSequenceMode(mode){els.exact.classList.toggle("active",mode==="exact");els.upto.classList.toggle("active",mode==="upTo");}
  async function show(mode){
    const number=Number(els.sequenceFilter.value);if(!Number.isFinite(number)||number<1)return setStatus("Enter a sequence number first");
    setSequenceMode(mode);const rows=selectedForSequence(mode),targets=targetsForRows(rows);
    if(!state.workspace?.viewer)return setStatus(`Found ${rows.length} assemblies`,"Viewer visibility is available only inside Trimble Connect.");
    try{
      let viewerObjectCount=0;
      let cameraWarning="";
      if(targets.length){
        const isolated=await isolateTargets(targets);viewerObjectCount=isolated.visibleCount;
        try{await state.workspace.viewer.setCamera({modelObjectIds:isolated.visibleTargets},{animationTime:300});}catch(error){cameraWarning=` · Camera fit failed: ${error.message||String(error)}`;}
      }else await setAllVisibility(false);
      const filterMessage=mode==="exact"?`Sequence ${number} only`:`Sequences up to ${number}`;
      setStatus(`Showing ${rows.length} assemblies`,`${filterMessage} · ${viewerObjectCount} verified visible objects${cameraWarning}`);
    }catch(error){await setAllVisibility(true).catch(()=>{});setStatus(`Found ${rows.length} assemblies`,`Viewer isolation failed; full-model visibility was restored. ${error.message||String(error)}`);}
  }
  async function showAll(){setSequenceMode("upTo");if(!state.workspace?.viewer)return;try{await setAllVisibility(true);setStatus("Showing all assemblies","Sequence filter cleared.");}catch(error){setStatus("Could not restore viewer visibility",error.message||String(error));}}
  let sequenceInputTimer;
  function sequenceInputChanged(){clearTimeout(sequenceInputTimer);const number=Number(els.sequenceFilter.value);sequenceInputTimer=setTimeout(()=>number>=1?show("upTo"):showAll(),180);}
  function showFromButton(mode){clearTimeout(sequenceInputTimer);show(mode);}
  async function color(){try{for(const status of statuses){const targets=targetsForRows(state.assemblies.filter(row=>row.status===status));if(targets.length)await state.workspace?.viewer?.setObjectState({modelObjectIds:targets},{...colors[status],visible:true});}setStatus("Applied status colours","All loaded assemblies are visible and coloured by status.");}catch(error){setStatus("Could not apply status colours",error.message||String(error));}}
  async function resumeStorageWithToken(value) {
    const token=permissionToken(value);if(!token)return;
    state.accessToken=token;
    const pendingRows=state.assemblies.filter(row=>state.pendingWriteIds.has(row.uniqueId));const ready=await initializeTrimbleStorage({load:!pendingRows.length});
    if(ready&&pendingRows.length)await saveRowsToTrimble(pendingRows);
  }
  async function reloadProject() {
    try{clearProjectData();render();state.project=await state.workspace.project.getProject();setStatus(`Connected to ${state.project?.name||"Trimble Connect"}`);await refresh();await enableTrimbleStorage();}
    catch(error){setStatus("Could not reload the Trimble project",error.message||String(error));}
  }
  function onWorkspaceEvent(event,args) {
    if(event==="extension.accessToken"||event==="embed.session.refreshed")void resumeStorageWithToken(args?.data??args);
    else if(event==="project.onChanged"){
      const nextId=norm(args?.data?.id??args?.data?.projectId);if(!nextId||nextId!==state.project?.id)void reloadProject();
    }else if(event==="extension.sessionInvalid"||event==="extension.sessionLogOut"){
      clearTransientData();render();setStatus("Trimble session ended","Reopen the extension after signing in. No token or schedule draft was retained.");
    }else if(event==="extension.closing")clearTransientData();
  }
  async function connect(){
    render();const bridge=window.TrimbleConnectWorkspace;
    if(!bridge?.connect)return setStatus("Standalone mode — open this as a Trimble extension.","Property Set storage is available only inside the current Trimble project.");
    try{state.workspace=await bridge.connect(window.parent,onWorkspaceEvent,30000);state.project=await state.workspace.project.getProject();setStatus(`Connected to ${state.project?.name||"Trimble Connect"}`);await refresh();await enableTrimbleStorage();}
    catch(error){setStatus("Standalone mode — connection unavailable.",error.message||String(error));}
  }
  window.addEventListener("pagehide", clearTransientData);
  window.addEventListener("beforeunload", clearTransientData);
  els.refresh.addEventListener("click",refresh);els.import.addEventListener("change",e=>importExcel(e.target.files[0]));els.importToTrimble.addEventListener("click",saveImportedRows);els.export.addEventListener("click",exportExcel);els.template.addEventListener("click",template);els.apply.addEventListener("click",apply);els.search.addEventListener("input",render);els.sequenceFilter.addEventListener("input",sequenceInputChanged);els.exact.addEventListener("click",()=>showFromButton("exact"));els.upto.addEventListener("click",()=>showFromButton("upTo"));els.color.addEventListener("click",color);setSequenceMode("upTo");connect();
})();
