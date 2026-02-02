import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/common/Sidebar';
import Topbar from '../components/common/Topbar';
import Footer from '../components/common/Footer';

const MainLayout = () => {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar 
          isOpen={sidebarOpen} 
          onToggle={() => setSidebarOpen(!sidebarOpen)} 
        />
        
        <div className="flex-1 flex flex-col overflow-hidden">
          <Topbar onMenuClick={() => setSidebarOpen(!sidebarOpen)} />
          
          <main className="flex-1 overflow-y-auto p-4 md:p-6">
            <Outlet />
          </main>
        </div>
      </div>

      <Footer />
    </div>
  );
};

export default MainLayout;
