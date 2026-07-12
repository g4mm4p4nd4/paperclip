DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'company_secrets'
      AND column_name = 'name'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'company_secrets'
      AND column_name = 'key'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM public.company_secrets
      WHERE name IS DISTINCT FROM key
    ) THEN
      RAISE EXCEPTION 'company_secrets_existing_name_key_mismatch';
    END IF;

    CREATE OR REPLACE FUNCTION public.paperclip_company_secrets_legacy_key_compat()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      name_changed boolean := false;
      key_changed boolean := false;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        name_changed := NEW.name IS DISTINCT FROM OLD.name;
        key_changed := NEW.key IS DISTINCT FROM OLD.key;
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.name IS NULL AND NEW.key IS NULL THEN
          RAISE EXCEPTION 'company_secrets_name_and_key_required';
        ELSIF NEW.name IS NULL THEN
          NEW.name := NEW.key;
        ELSIF NEW.key IS NULL THEN
          NEW.key := NEW.name;
        ELSIF NEW.name IS DISTINCT FROM NEW.key THEN
          RAISE EXCEPTION 'company_secrets_name_key_mismatch';
        END IF;
      ELSIF name_changed AND key_changed THEN
        IF NEW.name IS NULL OR NEW.key IS NULL OR NEW.name IS DISTINCT FROM NEW.key THEN
          RAISE EXCEPTION 'company_secrets_name_key_mismatch';
        END IF;
      ELSIF name_changed THEN
        IF NEW.name IS NULL THEN
          RAISE EXCEPTION 'company_secrets_name_and_key_required';
        END IF;
        NEW.key := NEW.name;
      ELSIF key_changed THEN
        IF NEW.key IS NULL THEN
          RAISE EXCEPTION 'company_secrets_name_and_key_required';
        END IF;
        NEW.name := NEW.key;
      ELSIF NEW.name IS NULL OR NEW.key IS NULL OR NEW.name IS DISTINCT FROM NEW.key THEN
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

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'company_secret_versions'
      AND column_name = 'value_sha256'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'company_secret_versions'
      AND column_name = 'fingerprint_sha256'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM public.company_secret_versions
      WHERE value_sha256 IS DISTINCT FROM fingerprint_sha256
    ) THEN
      RAISE EXCEPTION 'company_secret_versions_existing_hash_mismatch';
    END IF;

    CREATE OR REPLACE FUNCTION public.paperclip_company_secret_versions_legacy_fingerprint_compat()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      value_hash_changed boolean := false;
      fingerprint_changed boolean := false;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        value_hash_changed := NEW.value_sha256 IS DISTINCT FROM OLD.value_sha256;
        fingerprint_changed := NEW.fingerprint_sha256 IS DISTINCT FROM OLD.fingerprint_sha256;
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.value_sha256 IS NULL AND NEW.fingerprint_sha256 IS NULL THEN
          RAISE EXCEPTION 'company_secret_versions_hash_required';
        ELSIF NEW.value_sha256 IS NULL THEN
          NEW.value_sha256 := NEW.fingerprint_sha256;
        ELSIF NEW.fingerprint_sha256 IS NULL THEN
          NEW.fingerprint_sha256 := NEW.value_sha256;
        ELSIF NEW.value_sha256 IS DISTINCT FROM NEW.fingerprint_sha256 THEN
          RAISE EXCEPTION 'company_secret_versions_hash_mismatch';
        END IF;
      ELSIF value_hash_changed AND fingerprint_changed THEN
        IF NEW.value_sha256 IS NULL OR NEW.fingerprint_sha256 IS NULL OR
            NEW.value_sha256 IS DISTINCT FROM NEW.fingerprint_sha256 THEN
          RAISE EXCEPTION 'company_secret_versions_hash_mismatch';
        END IF;
      ELSIF value_hash_changed THEN
        IF NEW.value_sha256 IS NULL THEN
          RAISE EXCEPTION 'company_secret_versions_hash_required';
        END IF;
        NEW.fingerprint_sha256 := NEW.value_sha256;
      ELSIF fingerprint_changed THEN
        IF NEW.fingerprint_sha256 IS NULL THEN
          RAISE EXCEPTION 'company_secret_versions_hash_required';
        END IF;
        NEW.value_sha256 := NEW.fingerprint_sha256;
      ELSIF NEW.value_sha256 IS NULL OR NEW.fingerprint_sha256 IS NULL OR
          NEW.value_sha256 IS DISTINCT FROM NEW.fingerprint_sha256 THEN
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
