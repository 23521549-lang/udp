import {
  authSessionResponseWire,
  meResponseWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput extends LoginInput {
  name: string;
}

export const authApi = {
  me: () => api(meResponseWire, "/auth/me"),
  login: (body: LoginInput) =>
    api(authSessionResponseWire, "/auth/login", { method: "POST", body }),
  register: (body: RegisterInput) =>
    api(authSessionResponseWire, "/auth/register", { method: "POST", body }),
  logout: () => api(null, "/auth/logout", { method: "POST" }),
};
