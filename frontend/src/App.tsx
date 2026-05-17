import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { DetailPage } from "./pages/DetailPage";
import { LibraryPage } from "./pages/LibraryPage";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/meeting/:meetingId" element={<DetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
