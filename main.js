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

const notRemoved = encodeURIComponent(JSON.stringify({ field: 'isRemoved', eq: false }));

const embedUsers = encodeURIComponent(JSON.stringify({
    groups: {
        _through: {
            period: true
        }
    },
    meansOfLogin: true
}));

let token          = '';
let buckuttMembers = [];

axios.post(`https://${config.buckutt.api}/services/login`, credentials, options)
    .then((login) => {
        token = login.data.token;
        options.headers = {'Authorization': `Bearer ${token}`};

        return axios.get(`https://${config.buckutt.api}/users/search?q=${notRemoved}&embed=${embedUsers}`, options);
    })
    .then((members) => {
        buckuttMembers = members.data.map(member => ({
            id     : member.id,
            mail   : member.mail,
            current: {
                contributor   : (member.groups.findIndex(group => group.id === config.buckutt.contributorGroup && group._through.period.id === config.buckutt.defaultPeriod) > -1),
                nonContributor: (member.groups.findIndex(group => group.id === config.buckutt.nonContributorGroup && group._through.period.id === config.buckutt.defaultPeriod) > -1)
            },
            meansOfLogin: member.meansOfLogin.map(mol => mol.type)
        }));

        return axios.get(`http://${config.erp.host}/api/index.php/members?DOLAPIKEY=${config.erp.key}`);
    })
    .then((users) => {
        const students = users.data.map(etu => ({
            etuId      : etu.array_options.options_student,
            firstname  : etu.firstname,
            lastname   : etu.lastname,
            login      : etu.login,
            mail       : etu.email,
            contributor: (etu.datefin <= Math.ceil(new Date().getTime()/1000))
        }));

        const usersRequests = [];

        students.forEach((student) => {
            const memberIndex = buckuttMembers.findIndex(m => m.mail === student.mail);

            if (memberIndex === -1) {
                const newUser = {
                    firstname: student.firstname,
                    lastname : student.lastname,
                    pin      : 'notGenYet',
                    password : 'notGenYet',
                    mail     : student.mail
                };

                const newMols = [{
                    type: 'etuId',
                    data: `22000000${student.etuId}`
                }, {
                    type: 'etuMail',
                    data: student.mail
                }, {
                    type: 'etuLogin',
                    data: student.login
                }, {
                    type: 'etuNumber',
                    data: student.etuId
                }];

                usersRequests.push(createUser(newUser, newMols, student.contributor));
            } else {
                if (buckuttMembers[memberIndex].meansOfLogin.indexOf('etuId') === -1) {
                    usersRequests.push(addMolToUser(buckuttMembers[memberIndex].id, { type: 'etuId', data: `22000000${student.etuId}` }));
                }
                if (buckuttMembers[memberIndex].meansOfLogin.indexOf('etuMail') === -1) {
                    usersRequests.push(addMolToUser(buckuttMembers[memberIndex].id,{ type: 'etuMail', data: student.mail }));
                }
                if (buckuttMembers[memberIndex].meansOfLogin.indexOf('etuLogin') === -1) {
                    usersRequests.push(addMolToUser(buckuttMembers[memberIndex].id, { type: 'etuLogin', data: student.login }));
                }
                if (buckuttMembers[memberIndex].meansOfLogin.indexOf('etuNumber') === -1) {
                    usersRequests.push(addMolToUser(buckuttMembers[memberIndex].id, { type: 'etuNumber', data: student.etuId }));
                }

                buckuttMembers[memberIndex].isContributor = student.contributor;
            }
        });

        return Promise.all(usersRequests);
    })
    .then((usersCreated) => {
        buckuttMembers = buckuttMembers.concat(usersCreated);

        const membershipRequests = [];

        buckuttMembers.forEach((member) => {
            if (member.current.contributor && !member.isContributor) {
                membershipRequests.push(removeUserFromGroup(member.id, config.buckutt.contributorGroup, config.buckutt.defaultPeriod));
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
    molToCreate.User_id = userId;
    console.log(`Add mol ${mol.data} to user ${userId}`);
    return axios.post(`https://${config.buckutt.api}/meansoflogin`, molToCreate, options);
}

function addUserToGroup(userId, groupId, periodId) {
    const filter = { Period_id: periodId };
    console.log(`Add user ${userId} to group ${groupId} (period ${periodId})`);
    return axios.post(`https://${config.buckutt.api}/users/${userId}/groups/${groupId}`, filter, options);
}

function removeUserFromGroup(userId, groupId, periodId) {
    const filter    = { Period_id: periodId };
    const urlFilter = `?filter=${encodeURIComponent(JSON.stringify(filter))}`;
    console.log(`Remove user ${userId} from group ${groupId} (period ${periodId})`);
    return axios.delete(`https://${config.buckutt.api}/users/${userId}/groups/${groupId}${urlFilter}`, options);
}
