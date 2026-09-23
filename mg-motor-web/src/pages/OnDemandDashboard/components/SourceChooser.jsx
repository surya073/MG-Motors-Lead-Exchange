import { useRef, useState } from "react";
import { ChevronRightIcon, FilePdfIcon, FileSheetIcon, RefreshIcon, UploadIcon, XIcon, ZapIcon } from "./icons";
import chooserBg from "../../../assets/odd/odbg2.jpg";


const ACCEPTED = ".pdf,.xlsx,.xls,.csv";

// TODO(live-data-integration): replace with a real fetch against your
// existing dealers/leads/logs services (e.g. the same calls DealerListPage
// or SyncLogsPage already make) once this is wired to the backend.
const APP_DATA_SNAPSHOT = [
  { label: "Leads", value: "482" },
  { label: "Dealers", value: "36" },
  { label: "Synced Reports", value: "129" },
];

function fileMeta(file) {
  const isSheet = /\.(xlsx|xls|csv)$/i.test(file.name);
  return { isSheet, Icon: isSheet ? FileSheetIcon : FilePdfIcon };
}

export default function SourceChooser({ onGenerate, onBack }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const addFiles = (fileList) => {
    const incoming = Array.from(fileList).map((file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      file,
    }));
    setFiles((prev) => [...prev, ...incoming]);
  };

  const removeFile = (id) => setFiles((prev) => prev.filter((f) => f.id !== id));

  const handleRefresh = () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 700);
  };

  return (
      <div className="odd-chooser">
      <div className="odd-chooser__bg" style={{ backgroundImage: `url(${chooserBg})` }} />
      <div className="odd-chooser__bg-veil" />

      <button type="button" className="odd-back" onClick={onBack}>
        <ChevronRightIcon size={14} className="odd-back__icon" /> Back
      </button>

      <div className="odd-chooser__head">
        <h2>How do you want to build this dashboard?</h2>
        <p>Choose a source — you can always add the other one later.</p>
      </div>

      <div className="odd-chooser__grid">
        {/* ---- Container 1: Upload a document ---- */}
        <div className="odd-source-card">
          <div className="odd-source-card__head">
            <span className="odd-source-card__icon">
              <UploadIcon size={20} />
            </span>
            <div>
              <h3>Upload Document</h3>
              <p>PDF, Excel, or CSV — AI extracts KPIs and trends automatically.</p>
            </div>
          </div>

          <div
            className={`odd-dropzone odd-dropzone--compact ${dragging ? "odd-dropzone--active" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
            }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
          >
            <UploadIcon size={18} />
            <p>
              <strong>Drop a file</strong> or click to browse
            </p>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED}
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {files.length > 0 && (
            <ul className="odd-file-chip-list">
              {files.map((entry) => {
                const { isSheet, Icon } = fileMeta(entry.file);
                return (
                  <li key={entry.id} className="odd-file-chip">
                    <span className={isSheet ? "odd-file-chip__icon--sheet" : "odd-file-chip__icon"}>
                      <Icon size={13} />
                    </span>
                    <span>{entry.file.name}</span>
                    <button type="button" onClick={() => removeFile(entry.id)} aria-label="Remove file">
                      <XIcon size={11} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <button
            type="button"
            className="odd-btn odd-btn--primary odd-source-card__cta"
            disabled={files.length === 0}
            onClick={() => onGenerate("upload", { files: files.map((f) => f.file) })}
          >
            Generate Dashboard
            <ChevronRightIcon size={15} />
          </button>
        </div>

        {/* ---- Container 2: Fetch live app data ---- */}
        <div className="odd-source-card">
          <div className="odd-source-card__head">
            <span className="odd-source-card__icon odd-source-card__icon--alt">
              <ZapIcon size={20} />
            </span>
            <div>
              <h3>Use App Data</h3>
              <p>Pull live dealers, leads, and sync-log data straight from MG Motor.</p>
            </div>
          </div>

          <div className="odd-snapshot">
            <div className="odd-snapshot__row">
              <span>Live snapshot</span>
              <button type="button" className="odd-icon-btn odd-icon-btn--sm" onClick={handleRefresh} aria-label="Refresh snapshot">
                <RefreshIcon size={14} className={refreshing ? "odd-spin" : ""} />
              </button>
            </div>
            <div className="odd-snapshot__stats">
              {APP_DATA_SNAPSHOT.map((s) => (
                <div key={s.label}>
                  <strong>{s.value}</strong>
                  <span>{s.label}</span>
                </div>
              ))}
            </div>
          </div>

          <button
            type="button"
            className="odd-btn odd-btn--primary odd-source-card__cta"
            onClick={() => onGenerate("app", {})}
          >
            Generate Dashboard
            <ChevronRightIcon size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}