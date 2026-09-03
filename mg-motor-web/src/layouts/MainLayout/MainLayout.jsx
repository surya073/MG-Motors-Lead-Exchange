import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar/Sidebar";
import Navbar from "./Navbar/Navbar";
import { useLayout } from "../../contexts/LayoutContext";
import "./MainLayout.css";

export default function MainLayout() {
  const { collapsed } = useLayout();

  return (
    <div className={`main-layout ${!collapsed ? "main-layout--expanded" : ""}`}>
      <Sidebar />

      <div className="main-layout__main">
        <div className="main-layout__scroll">
          <header className="main-layout__header">
            <Navbar />
          </header>

          <main className="main-layout__content">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}