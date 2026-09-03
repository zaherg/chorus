export type BooleanTokenValidation =
    | { ok: true; separatorPresent: boolean }
    | {
          ok: false;
          option: string;
          token: string;
      };
