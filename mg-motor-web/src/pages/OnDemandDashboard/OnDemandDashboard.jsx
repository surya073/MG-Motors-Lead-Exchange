import { useRef, useState } from "react";
import EntranceOverlay from "./components/EntranceOverlay";
import LandingHero from "./components/LandingHero";
import SourceChooser from "./components/SourceChooser";
import GeneratingOverlay from "./components/GeneratingOverlay";
import DashboardView from "./components/DashboardView";
import AiAssistant from "./components/AiAssistant";
import WaterSurface from "./components/WaterSurface";
import { analyzeUploadedFile, fetchAppDataSummary } from "./services/aiService";
import { mapAppDataToDashboard } from "./utils/mapAppDataToDashboard";
import { mapAiResultToDashboard } from "./utils/mapAiResultToDashboard";
import "./OnDemandDashboard.css";
import "./components/components.css";

/**
 * OnDemandDashboard.jsx
 * -----------------------------------------------------------------------
 * Standalone page (intentionally rendered OUTSIDE MainLayout — see
 * AppRoutes.jsx — so it owns its own top bar / nav rail instead of the
 * app's Sidebar/Navbar).
 *
 * Stage machine:
 *   entrance   -> brand animation, once on mount
 *   landing    -> "MG Motor On-Demand Dashboard" intro + feature summary
 *   choose     -> two containers: Upload Document / Use App Data
 *   generating -> real work happens here (see handleGenerate below) while
 *                 GeneratingOverlay plays its step animation
 *   dashboard  -> DashboardView renders whatever handleGenerate produced,
 *                 falling back to sample data if it failed (see `error`)
 */
export default function OnDemandDashboard() {
  const [entranceDone, setEntranceDone] = useState(false);
  const [stage, setStage] = useState("landing"); // landing | choose | generating | dashboard
  const [source, setSource] = useState(null); // "upload" | "app"
  const [sourceFiles, setSourceFiles] = useState([]);
  const [dashboardData, setDashboardData] = useState(null);
  const [genError, setGenError] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const pendingWork = useRef(null);

  const handleGenerate = (chosenSource, payload) => {
    setSource(chosenSource);
    setSourceFiles(payload?.files || []);
    setGenError(null);
    setStage("generating");

    // Kicked off now, in parallel with GeneratingOverlay's step animation.
    // handleGeneratingComplete awaits this once that animation finishes,
    // so the stage transition always reflects real success/failure.
    pendingWork.current =
      chosenSource === "upload"
        ? Promise.all((payload.files || []).map((file) => analyzeUploadedFile(file))).then(mapAiResultToDashboard)
        : (payload?.summary ? Promise.resolve(payload.summary) : fetchAppDataSummary()).then(mapAppDataToDashboard);
  };

  const handleGeneratingComplete = async () => {
    try {
      const data = await pendingWork.current;
      setDashboardData(data);
    } catch (err) {
      console.error("On-Demand Dashboard generation failed", err);
      setGenError(err.message || "Something went wrong while generating the dashboard.");
      setDashboardData(null); // DashboardView falls back to sample data and shows the error banner
    }
    setStage("dashboard");
  };

  return (
    <div className="odd-root">
      {/* Ambient water layers — always mounted underneath every stage,
          independent of the entrance/landing/choose/generating/dashboard
          state machine below. See components/WaterSurface.jsx and the
          .odd-root__liquid-bg / .odd-water-canvas rules in the CSS. */}
      <span className="odd-root__liquid-bg" aria-hidden="true" />
      <WaterSurface />

      {!entranceDone && <EntranceOverlay onDone={() => setEntranceDone(true)} />}

      {entranceDone && stage === "landing" && (
        <div className="odd-stage odd-stage--center">
          <LandingHero onStart={() => setStage("choose")} />
        </div>
      )}

      {entranceDone && stage === "choose" && (
        <div className="odd-stage">
          <SourceChooser onGenerate={handleGenerate} onBack={() => setStage("landing")} />
        </div>
      )}

      {entranceDone && stage === "generating" && (
        <div className="odd-stage odd-stage--center">
          <GeneratingOverlay source={source} onComplete={handleGeneratingComplete} />
        </div>
      )}

      {entranceDone && stage === "dashboard" && (
        <>
          <DashboardView
            source={source}
            files={sourceFiles}
            data={dashboardData}
            error={genError}
            onBack={() => setStage("choose")}
          />
          <AiAssistant open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
        </>
      )}
    </div>
  );
}