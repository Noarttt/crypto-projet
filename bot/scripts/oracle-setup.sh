#!/usr/bin/env bash
# Crée le serveur gratuit du bot sur Oracle Cloud, à lancer dans Cloud Shell (terminal intégré à la console).
# Réseau public (VCN + passerelle Internet + sous-réseau), clé SSH, instance Ubuntu 24.04.
# Forme Ampere A1 (1 cœur, 6 Go, Always Free) ; repli sur VM.Standard.E2.1.Micro (Always Free) si capacité épuisée.
# Relançable sans risque : réutilise ce qui existe déjà.
set -euo pipefail

NAME="defi-bot"
KEY="$HOME/.ssh/defibot_rsa"

say() { printf '\n==> %s\n' "$*"; }

C="${OCI_TENANCY:-}"
if [ -z "$C" ]; then
  C="$(oci os ns get-metadata --query 'data."default-s3-compartment-id"' --raw-output)"
fi
[ -n "$C" ] || { echo "Impossible de trouver le compartiment racine."; exit 1; }

say "Domaine de disponibilité"
mapfile -t ADS < <(oci iam availability-domain list --compartment-id "$C" --query 'data[].name' --raw-output | tr -d '[]", ' | grep -v '^$')
echo "${ADS[@]}"

say "Réseau virtuel ${NAME}-vcn"
VCN="$(oci network vcn list --compartment-id "$C" --display-name "${NAME}-vcn" --lifecycle-state AVAILABLE --query 'data[0].id' --raw-output 2>/dev/null || true)"
if [ -z "$VCN" ] || [ "$VCN" = "null" ]; then
  VCN="$(oci network vcn create --compartment-id "$C" --cidr-blocks '["10.0.0.0/16"]' --display-name "${NAME}-vcn" --dns-label defibot \
    --wait-for-state AVAILABLE --query data.id --raw-output)"
fi
echo "$VCN"

say "Passerelle Internet"
IGW="$(oci network internet-gateway list --compartment-id "$C" --vcn-id "$VCN" --query 'data[0].id' --raw-output 2>/dev/null || true)"
if [ -z "$IGW" ] || [ "$IGW" = "null" ]; then
  IGW="$(oci network internet-gateway create --compartment-id "$C" --vcn-id "$VCN" --is-enabled true --display-name "${NAME}-igw" \
    --wait-for-state AVAILABLE --query data.id --raw-output)"
fi
RT="$(oci network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"' --raw-output)"
oci network route-table update --rt-id "$RT" --force \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null
echo "Route par défaut vers Internet : OK"

say "Sous-réseau public"
SUBNET="$(oci network subnet list --compartment-id "$C" --vcn-id "$VCN" --display-name "${NAME}-public" --query 'data[0].id' --raw-output 2>/dev/null || true)"
if [ -z "$SUBNET" ] || [ "$SUBNET" = "null" ]; then
  SUBNET="$(oci network subnet create --compartment-id "$C" --vcn-id "$VCN" --cidr-block 10.0.0.0/24 --display-name "${NAME}-public" \
    --dns-label pub --prohibit-public-ip-on-vnic false --wait-for-state AVAILABLE --query data.id --raw-output)"
fi
echo "$SUBNET"

say "Clé SSH (gardée dans Cloud Shell)"
mkdir -p "$HOME/.ssh"
[ -f "$KEY" ] || ssh-keygen -t rsa -b 4096 -N "" -f "$KEY" -q
echo "$KEY"

image_for() {
  oci compute image list --compartment-id "$C" --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
    --shape "$1" --sort-by TIMECREATED --sort-order DESC --all \
    --query "data[?!contains(\"display-name\", 'Minimal')] | [0].id" --raw-output
}

INST="$(oci compute instance list --compartment-id "$C" --display-name "$NAME" --lifecycle-state RUNNING --query 'data[0].id' --raw-output 2>/dev/null || true)"
if [ -z "$INST" ] || [ "$INST" = "null" ]; then
  launch() { # $1 forme, $2 config de forme (ou vide), $3 domaine
    local img; img="$(image_for "$1")"
    [ -n "$img" ] && [ "$img" != "null" ] || { echo "Pas d'image Ubuntu 24.04 pour $1"; return 1; }
    local extra=()
    [ -n "$2" ] && extra=(--shape-config "$2")
    oci compute instance launch --compartment-id "$C" --availability-domain "$3" --shape "$1" "${extra[@]}" \
      --image-id "$img" --subnet-id "$SUBNET" --assign-public-ip true --display-name "$NAME" \
      --ssh-authorized-keys-file "$KEY.pub" --wait-for-state RUNNING --query data.id --raw-output
  }
  for AD in "${ADS[@]}"; do
    say "Lancement Ampere A1 (1 cœur, 6 Go) dans $AD"
    if INST="$(launch VM.Standard.A1.Flex '{"ocpus":1,"memoryInGBs":6}' "$AD")"; then break; fi
    INST=""
    say "Ampere indisponible, essai VM.Standard.E2.1.Micro dans $AD"
    if INST="$(launch VM.Standard.E2.1.Micro "" "$AD")"; then break; fi
    INST=""
  done
fi
[ -n "$INST" ] || { echo; echo "Aucune capacité gratuite disponible pour l'instant. Relance la même commande plus tard."; exit 1; }

IP="$(oci compute instance list-vnics --instance-id "$INST" --query 'data[0]."public-ip"' --raw-output)"
cat > "$HOME/defibot-connexion.txt" <<EOF
ssh -i $KEY ubuntu@$IP
EOF

say "Terminé"
echo "Serveur : $NAME"
echo "IP publique : $IP"
echo
echo "Pour t'y connecter depuis Cloud Shell (attends 1 à 2 minutes le premier démarrage) :"
echo "  ssh -i $KEY ubuntu@$IP"
echo "(commande aussi enregistrée dans ~/defibot-connexion.txt)"
