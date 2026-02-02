import axios from 'axios';

const API = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'https://voiceagentbot.com/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor
API.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor
API.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Auth API
export const authAPI = {
  login: (credentials) => API.post('/auth/login', credentials),
  register: (userData) => API.post('/auth/register', userData),
  getMe: () => API.get('/auth/me'),
  logout: () => API.post('/auth/logout'),
};

// Campaign API
export const campaignAPI = {
  getAll: () => API.get('/campaigns'),
  getById: (id) => API.get(`/campaigns/${id}`),
  create: (data) => API.post('/campaigns', data),
  update: (id, data) => API.put(`/campaigns/${id}`, data),
  delete: (id) => API.delete(`/campaigns/${id}`),
};

// Voice API
export const voiceAPI = {
  getAll: () => API.get('/voices'),
  getById: (id) => API.get(`/voices/${id}`),
  clone: (data) => API.post('/voices/clone', data, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),
  delete: (id) => API.delete(`/voices/${id}`),
  assign: (id, campaignId) => API.post(`/voices/${id}/assign`, { campaignId }),
    play: (id, text = 'Hello, this is a sample.i am you calling AI Agents, How May i Help you') =>
    API.post(`/voices/${id}/play`, { text }, { responseType: 'arraybuffer' }),
};

// User API
export const userAPI = {
  getAll: () => API.get('/users'),
  getById: (id) => API.get(`/users/${id}`),
  update: (id, data) => API.put(`/users/${id}`, data),
  delete: (id) => API.delete(`/users/${id}`),
};
export const dashboardAPI = {
  getSummary: () => API.get('/dashboard/summary'),
};
export default API;