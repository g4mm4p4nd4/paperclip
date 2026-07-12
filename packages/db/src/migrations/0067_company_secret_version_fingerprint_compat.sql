DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'company_secret_versions'
      AND column_name = 'fingerprint_sha256'
  ) THEN
    CREATE OR REPLACE FUNCTION public.paperclip_company_secret_versions_legacy_fingerprint_compat()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW.value_sha256 IS NULL AND NEW.fingerprint_sha256 IS NULL THEN
        RAISE EXCEPTION 'company_secret_versions_hash_required';
      ELSIF NEW.value_sha256 IS NULL THEN
        NEW.value_sha256 := NEW.fingerprint_sha256;
      ELSIF NEW.fingerprint_sha256 IS NULL THEN
        NEW.fingerprint_sha256 := NEW.value_sha256;
      ELSIF NEW.value_sha256 <> NEW.fingerprint_sha256 THEN
        RAISE EXCEPTION 'company_secret_versions_hash_mismatch';
      END IF;
      RETURN NEW;
    END;
    $function$;

    DROP TRIGGER IF EXISTS company_secret_versions_legacy_fingerprint_compat_trg
      ON public.company_secret_versions;
    CREATE TRIGGER company_secret_versions_legacy_fingerprint_compat_trg
      BEFORE INSERT OR UPDATE OF value_sha256, fingerprint_sha256
      ON public.company_secret_versions
      FOR EACH ROW
      EXECUTE FUNCTION public.paperclip_company_secret_versions_legacy_fingerprint_compat();
  END IF;
END
$$;
