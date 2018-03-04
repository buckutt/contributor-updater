const axios   = require('axios');
const Promise = require('bluebird');
const fs      = require('fs');
const https   = require('https');
const config  = require('./config');

const agent = new https.Agent({
    pfx       : fs.readFileSync(`./${config.certificate.file}`),
    passphrase: config.certificate.password
});

const options = {
    httpsAgent: agent
};

const credentials = {
    data       : config.buckutt.admin.mol,
    password   : config.buckutt.admin.password,
    meanOfLogin: 'etuMail'
};

const embedUsers = encodeURIComponent(JSON.stringify([
    'meansOfLogin',
    'memberships'
]));

let token          = '';
let buckuttMembers = [];

axios.post(`https://${config.buckutt.api}/services/login`, credentials, options)
    .then((login) => {
        console.log('Logged to the BuckUTT API. Fetching BuckUTT users...');
        token = login.data.token;
        options.headers = {'Authorization': `Bearer ${token}`};

        return axios.get(`https://${config.buckutt.api}/users?embed=${embedUsers}`, options);
    })
    .then((members) => {
        console.log('BuckUTT users fetched. Fetching ERP users...');
        buckuttMembers = members.data.map(member => ({
            id     : member.id,
            mail   : member.mail,
            current: {
                contributor   : member.memberships.find(membership => membership.group_id === config.buckutt.contributorGroup && membership.period_id === config.buckutt.defaultPeriod),
                nonContributor: member.memberships.find(membership => membership.group_id === config.buckutt.nonContributorGroup && membership.period_id === config.buckutt.defaultPeriod)
            },
            meansOfLogin: Object.assign({}, ...member.meansOfLogin.map(mol => ({[mol.type]: mol}))),
        }));

        return axios.get(`http://${config.erp.host}/api/index.php/members?DOLAPIKEY=${config.erp.key}`);
    })
    .then((users) => {
        console.log('ERP users fetched. Creating users and mols...');
        const students = users.data.map(etu => ({
            etuId      : etu.array_options.options_student,
            firstname  : etu.firstname,
            lastname   : etu.lastname,
            login      : etu.login,
            mail       : etu.email,
            contributor: ((parseInt(etu.datefin) >= Math.ceil(new Date().getTime()/1000) && etu.datefin !== '') || etu.need_subscription == 0)
        }));

        const usersRequests = [];

        students.forEach((student) => {
            let memberIndex = -1;
            // Try first to find user by student ID (safest field)
            if (student.etuId > 0) {
                memberIndex = buckuttMembers.findIndex(m => {
                    return m.meansOfLogin.etuNumber && m.meansOfLogin.etuNumber.data === student.etuId.toString();
                });
            }

            // If not try to find by email
            if (memberIndex === -1) {
                memberIndex = buckuttMembers.findIndex(m => {
                    return m.mail === student.mail;
                });
            }

            if (memberIndex === -1) {
                const newUser = {
                    firstname: student.firstname,
                    lastname : student.lastname,
                    pin      : 'notGenYet',
                    password : 'notGenYet',
                    mail     : student.mail
                };

                const newMols = [{
                    type: 'etuMail',
                    data: student.mail
                }];

                if (student.etuId) {
                    newMols.push({
                        type: 'etuNumber',
                        data: student.etuId.toString()
                    }, {
                        type: 'etuId',
                        data: `22000000${student.etuId}`.toString()
                    });
                }

                usersRequests.push(createUser(newUser, newMols, student.contributor));
            } else {
                if (!('etuId' in buckuttMembers[memberIndex].meansOfLogin) && student.etuId) {
                    usersRequests.push(addMolToUser(buckuttMembers[memberIndex].id, { type: 'etuId', data: `22000000${student.etuId}` }));
                }
                if (!('etuMail' in buckuttMembers[memberIndex].meansOfLogin) && student.mail) {
                    usersRequests.push(addMolToUser(buckuttMembers[memberIndex].id, { type: 'etuMail', data: student.mail }));
                }
                else if (student.mail !== buckuttMembers[memberIndex].meansOfLogin.etuMail.data) {
                    usersRequests.push(updateUserMol(buckuttMembers[memberIndex].meansOfLogin.etuMail.id, { type: 'etuMail', data: student.mail }));
                }
                if (!('etuNumber' in buckuttMembers[memberIndex].meansOfLogin) && student.etuId) {
                    usersRequests.push(addMolToUser(buckuttMembers[memberIndex].id, { type: 'etuNumber', data: student.etuId }));
                }
                if (buckuttMembers[memberIndex].mail !== student.mail) {
                    usersRequests.push(updateUserMail(buckuttMembers[memberIndex].id, student.mail ));
                }

                buckuttMembers[memberIndex].isContributor = student.contributor;
            }
        });

        return Promise.all(usersRequests);
    })
    .then((usersCreated) => {
        console.log('Users and mols created. Creating and removing memberships...');

        buckuttMembers = buckuttMembers.concat(usersCreated);

        const membershipRequests = [];

        buckuttMembers.forEach((member) => {
            if (member.current.contributor && !member.isContributor) {
                membershipRequests.push(removeUserFromGroup(member.current.contributor));
            } else if (!member.current.contributor && member.isContributor) {
                membershipRequests.push(addUserToGroup(member.id, config.buckutt.contributorGroup, config.buckutt.defaultPeriod));
            }

            if (!member.current.nonContributor) {
                membershipRequests.push(addUserToGroup(member.id, config.buckutt.nonContributorGroup, config.buckutt.defaultPeriod));
            }
        });

        return Promise.all(membershipRequests);
    })
    .then(() => console.log('Sync finished.'))
    .catch(error => console.log(error));


function createUser(user, mols, contributor) {
    let createdUser = {};
    console.log(`Create user ${user.mail} and its mols`);
    return axios.post(`https://${config.buckutt.api}/users`, user, options)
        .then((newUser) => {
            createdUser = {
                id     : newUser.data.id,
                mail   : newUser.data.mail,
                current: {
                    contributor   : false,
                    nonContributor: false
                },
                isContributor: contributor
            };

            const molsRequests = [];

            mols.forEach(mol => molsRequests.push(addMolToUser(createdUser.id, mol)));

            return Promise.all(molsRequests);
        })
        .then(() => Promise.resolve(createdUser));
}

function addMolToUser(userId, mol) {
    const molToCreate   = mol;
    molToCreate.user_id = userId;
    console.log(`Add mol ${mol.type}=${mol.data} to user ${userId}`);
    return axios.post(`https://${config.buckutt.api}/meansoflogin`, molToCreate, options);
}

function updateUserMol(molId, mol) {
    console.log(`Update mol ${mol.type}=${mol.data} of meansOfLogin ${molId}`);
    return axios.put(`https://${config.buckutt.api}/meansoflogin/${molId}`, mol, options);
}

function updateUserMail(userId, mail) {
    console.log(`Update mail ${mail} of user ${userId}`);
    return axios.put(`https://${config.buckutt.api}/users/${userId}`, {mail: mail}, options);
}

function addUserToGroup(userId, groupId, periodId) {
    const membership = {
        user_id  : userId,
        group_id : groupId,
        period_id: periodId
    };

    console.log(`Add user ${userId} to group ${groupId} (period ${periodId})`);
    return axios.post(`https://${config.buckutt.api}/memberships`, membership, options);
}

function removeUserFromGroup(membership) {
    console.log(`Remove user ${membership.user_id} from group ${membership.group_id} (period ${membership.period_id})`);
    return axios.delete(`https://${config.buckutt.api}/memberships/${membership.id}`, options);
}
