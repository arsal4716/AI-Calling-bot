import React from "react";
import { NavLink } from "react-router-dom";
import {
  Home,
  Phone,
  PhoneCall,
  History,
  Mic,
  Users,
  HelpCircle,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Volume2,
} from "lucide-react";
import { useAuth } from "../../store/authContext";

const Sidebar = ({ isOpen, onToggle }) => {
  const { logout } = useAuth();

  const menuItems = [
    {
      icon: <Home className="h-4 w-5" />,
      label: "Dashboard",
      path: "/dashboard",
    },
    {
      icon: <Phone className="h-4 w-5" />,
      label: "Campaigns",
      path: "/campaigns",
    },
    {
      icon: <PhoneCall className="h-4 w-5" />,
      label: "Dialer",
      path: "/dialer",
    },
    {
      icon: <History className="h-4 w-5" />,
      label: "Call Logs",
      path: "/call-logs",
    },
    {
      icon: <Volume2 className="h-4 w-5" />,
      label: "Custom Voices",
      path: "/custom-voices",
    },
    {
      icon: <Mic className="h-4 w-5" />,
      label: "Voice Cloning",
      path: "/voices",
    },
    { icon: <Users className="h-4 w-5" />, label: "Users", path: "/users" },
    {
      icon: <HelpCircle className="h-4 w-5" />,
      label: "User Guidance",
      path: "/guide",
    },
  ];

  return (
    <aside
      className={`bg-gray-900 text-white transition-all duration-300 ${isOpen ? "w-64" : "w-20"} h-full flex flex-col`}
    >
      <div className="p-6 border-b border-gray-800 flex items-center justify-between">
        {isOpen ? (
          <h1 className="text-xl font-bold text-white">AI Calling Platform</h1>
        ) : (
          <div className="h-8 w-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <Phone className="h-5 w-5 text-white" />
          </div>
        )}
        <button
          onClick={onToggle}
          className="p-1 rounded-md hover:bg-gray-800 text-gray-400 hover:text-white"
        >
          {isOpen ? (
            <ChevronLeft className="h-5 w-5" />
          ) : (
            <ChevronRight className="h-5 w-5" />
          )}
        </button>
      </div>

      <nav className="flex-1 p-4 space-y-2">
        {menuItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `flex items-center space-x-2 p-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? "bg-blue-600 text-white"
                  : "text-gray-300 hover:bg-gray-800 hover:text-white"
              }`
            }
          >
            {item.icon}
            {isOpen && <span className="font-medium">{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      <div className="p-4 border-t border-gray-800">
        <button
          onClick={logout}
          className="flex items-center space-x-3 p-3 rounded-lg text-gray-300 hover:bg-gray-800 hover:text-white w-full"
        >
          <LogOut className="h-5 w-5" />
          {isOpen && <span className="font-medium">Logout</span>}
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
