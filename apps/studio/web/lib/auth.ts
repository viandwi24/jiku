import { useAuthStore } from './store/auth.store'

export function getToken(): string | null {
  return useAuthStore.getState().token
}

export function setToken(_token: string): void {
  // token is stored via setAuth in the zustand store — no-op here
}

export function clearToken(): void {
  // handled by clearAuth in the zustand store — no-op here
}

export function getAuthHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}
