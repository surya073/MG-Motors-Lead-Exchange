import { useRef, useState } from "react";
import useLiquidPointer from "../hooks/useLiquidPointer";
import { analyzeUploadedFile } from "../services/aiService";
import { CheckIcon, ClockIcon, FilePdfIcon, FileSheetIcon, SparklesIcon, UploadIcon, XIcon } from "./icons";

const ACCEPTED = ".pdf,.xlsx,.xls,.csv";

function fileMeta(file) {
  const isSheet = /\.(xlsx|xls|csv)$/i.test(file.name);
  return { isSheet, Icon: isSheet ? FileSheetIcon : FilePdfIcon };
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadPanel({ delay = 0 }) {
  const liquidRef = useLiquidPointer();
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState([]);

  const addFiles = (fileList) => {
    const incoming = Array.from(fileList).map((file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      file,
      status: "analyzing",
      result: null,
    }));
    if (!incoming.length) return;
    setFiles((prev) => [...incoming, ...prev]);

    incoming.forEach((entry) => {
      // TODO(gemini-integration): this is where the real upload + AI
      // analysis pipeline kicks off — see services/aiService.js for the
      // exact wiring point. Today it resolves to mock insights.
      analyzeUploadedFile(entry.file)
        .then((result) => {
          setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, status: "complete", result } : f)));
        })
        .catch(() => {
          setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, status: "failed" } : f)));
        });
    });
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files?.length) addFiles(event.dataTransfer.files);
  };

  const removeFile = (id) => setFiles((prev) => prev.filter((f) => f.id !== id));

  return (
    <div ref={liquidRef} className="odd-card odd-liquid odd-upload" style={{ "--odd-reveal-delay": `${delay}ms` }}>
      <div className="odd-chart-panel__head">
        <div>
          <h3 className="odd-chart-panel__title">On-Demand Analysis</h3>
          <p className="odd-chart-panel__subtitle">Upload a PDF, Excel, or CSV file — AI will generate KPIs, charts, and insights from it.</p>
        </div>
      </div>

      <div
        className={`odd-dropzone ${dragging ? "odd-dropzone--active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
      >
        <UploadIcon size={22} />
        <p>
          <strong>Drop a file</strong> or click to browse
        </p>
        <span>PDF, XLSX, XLS, CSV</span>
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
        <ul className="odd-upload-list">
          {files.map((entry) => {
            const { isSheet, Icon } = fileMeta(entry.file);
            return (
              <li key={entry.id} className="odd-upload-item">
                <span className={`odd-upload-item__icon ${isSheet ? "odd-upload-item__icon--sheet" : ""}`}>
                  <Icon size={16} />
                </span>
                <div className="odd-upload-item__body">
                  <div className="odd-upload-item__row">
                    <span className="odd-upload-item__name">{entry.file.name}</span>
                    <button type="button" className="odd-upload-item__remove" onClick={() => removeFile(entry.id)} aria-label="Remove file">
                      <XIcon size={13} />
                    </button>
                  </div>
                  <div className="odd-upload-item__meta">
                    <span>{formatSize(entry.file.size)}</span>
                    {entry.status === "analyzing" && (
                      <span className="odd-status odd-status--pending">
                        <ClockIcon size={11} /> Analyzing…
                      </span>
                    )}
                    {entry.status === "complete" && (
                      <span className="odd-status odd-status--complete">
                        <CheckIcon size={11} /> Insights ready
                      </span>
                    )}
                    {entry.status === "failed" && <span className="odd-status odd-status--failed">Analysis failed</span>}
                  </div>

                  {entry.status === "analyzing" && (
                    <div className="odd-progress">
                      <div className="odd-progress__bar" />
                    </div>
                  )}

                  {entry.status === "complete" && entry.result && (
                    <div className="odd-insight">
                      <p className="odd-insight__summary">
                        <SparklesIcon size={13} /> {entry.result.summary}
                      </p>
                      <ul className="odd-insight__list">
                        {entry.result.insights.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}