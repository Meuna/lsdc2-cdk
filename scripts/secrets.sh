#!/bin/bash

default="/lsdc2/discord-secrets"
printf "Name of the parameter ? [$default] "
read name
name=${name:-$default}

# Check for existing parameters
overwrite_check=$(aws ssm get-parameter --name "$name" 2>&1)
if [[ $? -eq 0 ]]; then
    printf "%s already exists. Overwrite ? ([y]/n) " "$name"
    read overwrite
    overwrite=${overwrite:-y}
    if [[ "$overwrite" != "y" ]]; then
        printf "Overwrite aborted"
        exit 1
    else
        printf "Deleting parameter %s ... "
        deletion_check=$(aws ssm delete-parameter --name "$name" 2>&1)
        if [[ $? -ne 0 ]]; then
            printf "failed with error %s" "$deletion_check"
            exit 1
        else
            printf "done !\n"
        fi
    fi
elif [[ "$overwrite_check" != *"ParameterNotFound"* ]]; then
    printf "Overwrite check for parameter %s failed with error %s" "$name" "$overwrite_check"
    exit 1
fi

# Prompt for Discord bot IDs and secrets
printf "Bot public key (General Information panel): "
read pkey

printf "Bot client ID (OAuth2/General panel): "
read client_id

printf "Bot client secret (OAuth2/General panel): "
read -s client_secret
printf "\n"

printf "Bot token (Bot panel): "
read -s token
printf "\n"

json_fmt='{"pkey":"%s","clientId":"%s","clientSecret":"%s","token":"%s"}'
json_value=$(printf "$json_fmt" "$pkey" "$client_id" "$client_secret" "$token")

aws ssm put-parameter \
    --name "$name" \
    --description "LSDC2 discord secrets" \
    --value $json_value \
    --type SecureString \
    --tier Standard \
    --tags Key=LSDC2-src,Value=script > /dev/null
