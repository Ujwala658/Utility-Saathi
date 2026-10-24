import { createContext, useContext } from 'react';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'tenant' | 'owner' | 'admin';
  isDemo: boolean;
}

export const AuthContext = createContext<{ user: User | null; login: (token: string, u: User) => void; logout: () => void }>(null as any);
export const useAuth = () => useContext(AuthContext);
