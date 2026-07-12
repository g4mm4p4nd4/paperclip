DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'company_secrets'
      AND column_name = 'key'
  ) THEN
    CREATE OR REPLACE FUNCTION public.paperclip_company_secrets_legacy_key_compat()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW.name IS NULL AND NEW.key IS NULL THEN
        RAISE EXCEPTION 'company_secrets_name_and_key_required';
      ELSIF NEW.name IS NULL THEN
        NEW.name := NEW.key;
      ELSIF NEW.key IS NULL THEN
        NEW.key := NEW.name;
      ELSIF NEW.name <> NEW.key THEN
        RAISE EXCEPTION 'company_secrets_name_key_mismatch';
      END IF;
      RETURN NEW;
    END;
    $function$;

    DROP TRIGGER IF EXISTS company_secrets_legacy_key_compat_trg ON public.company_secrets;
    CREATE TRIGGER company_secrets_legacy_key_compat_trg
      BEFORE INSERT OR UPDATE OF name, key
      ON public.company_secrets
      FOR EACH ROW
      EXECUTE FUNCTION public.paperclip_company_secrets_legacy_key_compat();
  END IF;
END
$$;
