import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './store/authContext';
import PrivateRoute from './components/PrivateRoute';
import MainLayout from './layouts/MainLayout';
import Dashboard from './pages/Dashboard';
import DialerPage from './pages/DialerPage';
import CallLogsPage from './pages/CallLogsPage';
import Campaigns from './pages/Campaigns';
import VoiceCloning from './pages/VoiceCloning';
import Users from './pages/Users';
import UserGuidance from './pages/UserGuidance';
import Login from './pages/Login';
import Register from './pages/Register';
import CustomVoices from './pages/CustomVoices';

function App() {
  return (
    <Router>
      <AuthProvider>
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#363636',
              color: '#fff',
            },
          }}
        />

        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          <Route
            path="/"
            element={
              <PrivateRoute>
                <MainLayout />
              </PrivateRoute>
            }
          >
            <Route index element={<Navigate to="/dashboard" />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="dialer" element={<DialerPage/>} />
            <Route path="call-logs" element={<CallLogsPage />} />
            <Route path="campaigns" element={<Campaigns />} />
            <Route path="custom-voices" element={<CustomVoices />} />
            <Route path="voices" element={<VoiceCloning />} />
            <Route path="users" element={<Users />} />
            <Route path="guide" element={<UserGuidance />} />
          </Route>
        </Routes>
      </AuthProvider>
    </Router>
  );
}

export default App;
