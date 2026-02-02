import React from 'react';
import { Bell, Menu, Search, User } from 'lucide-react';
import { useAuth } from '../../store/authContext';

const Topbar = ({ onMenuClick }) => {
  const { user } = useAuth();

  return (
    <header className="bg-white shadow-sm border-b border-gray-200 px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <button
            onClick={onMenuClick}
            className="p-2 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
          
          <div className="hidden lg:block">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
              <input
                type="search"
                placeholder="Search campaigns, calls, voices..."
                className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 w-64"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <button className="relative p-2 text-gray-500 hover:text-gray-700">
            <Bell className="h-5 w-5" />
            <span className="absolute top-1 right-1 h-2 w-2 bg-red-500 rounded-full"></span>
          </button>

          <div className="flex items-center space-x-3">
            <div className="text-right hidden md:block">
              <p className="text-sm font-medium text-gray-700">{user?.name}</p>
              <p className="text-xs text-gray-500">{user?.email}</p>
            </div>
            <div className="h-8 w-8 bg-blue-100 rounded-full flex items-center justify-center">
              <User className="h-5 w-5 text-blue-600" />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Topbar;